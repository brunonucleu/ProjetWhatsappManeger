// Importar módulos necessários
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios'); // Para fazer chamadas à API do WhatsApp
const crypto = require('crypto'); // Para verificar a assinatura do webhook
const bodyParser = require('body-parser'); // Para analisar o corpo das requisições webhook
require('dotenv').config(); // Para carregar variáveis de ambiente

// Configuração do App Express
const app = express();
// Usar bodyParser.json(), mas verificar a assinatura ANTES que o Express analise o JSON
// Precisamos do rawBody para a verificação da assinatura
app.use(bodyParser.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Permitir todas as origens para desenvolvimento/teste inicial
    methods: ["GET", "POST"]
  }
});

// --- Configuração da API do WhatsApp (Carregar de variáveis de ambiente) ---
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; // Token para verificar o webhook
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const APP_SECRET = process.env.APP_SECRET; // Segredo do App para verificar assinatura
const GRAPH_API_VERSION = 'v19.0'; // Usar uma versão específica da API

// Armazenamento em memória (simples, idealmente usar banco de dados)
let conversations = {}; // Estrutura: { 'whatsapp_user_id': { status: '...', messages: [], notes: '', botState: '...' } }

// --- Lógica do Bot de Triagem ---
const botMessages = {
  welcome: "Olá! Bem-vindo ao nosso atendimento. Como podemos ajudar?\n1. Abrir chamado\n2. Consultar andamento\n3. Informações/Dúvidas",
  invalidOption: "Opção inválida. Por favor, escolha 1, 2 ou 3.",
  askOS: "Entendido. Por favor, informe o número da sua Ordem de Serviço (OS).",
  askName: "Obrigado. Agora, por favor, informe seu nome completo.",
  infoForwarding: "Certo, sua solicitação de informação será encaminhada a um atendente.",
  statusForwarding: "Ok, sua consulta de andamento será verificada por um atendente.",
  ticketForwarding: "Seu chamado será aberto e encaminhado a um atendente. Informe seu nome e OS, por favor."
};

// Função para enviar mensagens via WhatsApp Cloud API
async function sendWhatsAppMessage(to, messageData) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.error('Erro: Variáveis de ambiente do WhatsApp não configuradas.');
    return;
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const headers = {
    'Authorization': `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    ...messageData // type: 'text', text: { body: '...' } ou type: 'interactive', interactive: { ... }
  };

  try {
    console.log(`Enviando mensagem para ${to}:`, JSON.stringify(body, null, 2));
    const response = await axios.post(url, body, { headers });
    console.log('Mensagem enviada com sucesso:', response.data);
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem via WhatsApp API:', error.response ? error.response.data : error.message);
    // Se houver erro de resposta da API, logar detalhes
    if (error.response && error.response.data && error.response.data.error) {
        console.error('Detalhes do erro da API:', error.response.data.error);
    }
    return null;
  }
}

// Função para processar a lógica do bot
async function handleBotLogic(userId, userMessageText) {
  let conversation = conversations[userId];
  let replyMessageText = '';
  let newStatus = conversation.status; // Mantém o status atual por padrão

  switch (conversation.botState) {
    case 'awaiting_initial_choice':
      const choice = parseInt(userMessageText.trim());
      if (choice === 1) {
        replyMessageText = botMessages.ticketForwarding;
        conversation.botState = 'awaiting_os'; // Ou direto para atendente?
        newStatus = 'Abertura de Chamado';
      } else if (choice === 2) {
        replyMessageText = botMessages.statusForwarding;
        conversation.botState = 'awaiting_os'; // Ou direto para atendente?
        newStatus = 'Consulta Andamento';
      } else if (choice === 3) {
        replyMessageText = botMessages.infoForwarding;
        conversation.botState = 'forwarded_to_agent';
        newStatus = 'Informações/Dúvidas';
      } else {
        replyMessageText = botMessages.invalidOption + '\n\n' + botMessages.welcome;
        // Mantém botState como 'awaiting_initial_choice'
      }
      break;
    // Adicionar mais estados se necessário (ex: awaiting_os, awaiting_name)
    case 'forwarded_to_agent':
      // Mensagem recebida após encaminhamento, apenas adiciona à conversa
      replyMessageText = ''; // Não envia resposta automática
      break;
    default:
      // Estado desconhecido ou inicial, envia boas-vindas
      replyMessageText = botMessages.welcome;
      conversation.botState = 'awaiting_initial_choice';
      newStatus = 'Aguardando Resposta Cliente'; // Status inicial
      break;
  }

  conversation.status = newStatus;

  if (replyMessageText) {
    await sendWhatsAppMessage(userId, { type: 'text', text: { body: replyMessageText } });
    // Adiciona a resposta do bot ao histórico
    conversation.messages.push({ sender: 'bot', text: replyMessageText, timestamp: new Date() });
  }

  // Atualiza a conversa no frontend
  io.emit('update_conversation', { userId, conversation });
}

// --- Rota Webhook do WhatsApp ---

// GET para verificação do Webhook
app.get('/webhook/whatsapp', (req, res) => {
  console.log('Recebida requisição GET para verificação do webhook...');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`Mode: ${mode}, Token: ${token}`);

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('Webhook verificado com sucesso!');
      res.status(200).send(challenge);
    } else {
      console.warn('Falha na verificação do webhook. Tokens não correspondem.');
      res.sendStatus(403); // Forbidden
    }
  } else {
    console.warn('Requisição de verificação inválida.');
    res.sendStatus(400); // Bad Request
  }
});

// POST para receber notificações de eventos (mensagens, status, etc.)
app.post('/webhook/whatsapp', (req, res) => {
  console.log('Recebida notificação POST do webhook:', JSON.stringify(req.body, null, 2));

  // 1. Verificar Assinatura (Segurança)
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) {
    console.warn('Requisição webhook sem assinatura.');
    return res.sendStatus(403);
  }

  const expectedSignature = 'sha256=' + crypto.createHmac('sha256', APP_SECRET)
                                        .update(req.rawBody)
                                        .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    console.warn('Assinatura do webhook inválida!');
    return res.sendStatus(403);
  }

  console.log('Assinatura do webhook verificada com sucesso.');

  // 2. Processar a notificação
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    body.entry.forEach(entry => {
      entry.changes.forEach(change => {
        if (change.field === 'messages') {
          const messageData = change.value.messages ? change.value.messages[0] : null;
          const contactData = change.value.contacts ? change.value.contacts[0] : null;
          const statusData = change.value.statuses ? change.value.statuses[0] : null;

          if (messageData && messageData.type === 'text') { // Processar apenas mensagens de texto recebidas por enquanto
            const from = messageData.from; // ID do usuário (número de telefone)
            const text = messageData.text.body;
            const messageId = messageData.id;

            console.log(`Mensagem recebida de ${from}: ${text}`);

            // Inicializa a conversa se for nova
            if (!conversations[from]) {
              conversations[from] = {
                userId: from,
                userName: contactData ? contactData.profile.name : from, // Pega o nome do perfil se disponível
                status: 'Nova Conversa', // Status inicial antes do bot
                messages: [],
                notes: '',
                botState: 'initial' // Estado inicial do bot
              };
              // Notifica o frontend sobre a nova conversa
              io.emit('new_conversation', conversations[from]);
            }

            // Adiciona a mensagem recebida ao histórico
            conversations[from].messages.push({ sender: 'user', text: text, timestamp: new Date(), id: messageId });

            // Atualiza o frontend com a nova mensagem
            io.emit('new_message', { userId: from, message: { sender: 'user', text: text, timestamp: new Date(), id: messageId } });

            // Chama a lógica do bot para processar a mensagem
            handleBotLogic(from, text);

          } else if (statusData) {
            // Processar atualizações de status (enviado, entregue, lido)
            const userId = statusData.recipient_id;
            const messageId = statusData.id;
            const status = statusData.status;
            const timestamp = new Date(parseInt(statusData.timestamp) * 1000);

            console.log(`Status da mensagem ${messageId} para ${userId}: ${status}`);

            if (conversations[userId]) {
              // Encontra a mensagem correspondente e atualiza seu status (se necessário)
              // (Lógica de atualização de status pode ser adicionada aqui)
              // Notifica o frontend sobre a atualização de status
              io.emit('message_status_update', { userId, messageId, status, timestamp });
            }
          } else {
            console.log('Tipo de mensagem/evento não tratado:', messageData ? messageData.type : 'Status ou outro');
          }
        }
      });
    });

    // Responde à Meta que a notificação foi recebida
    res.sendStatus(200);
  } else {
    // Se não for uma notificação esperada
    res.sendStatus(404);
  }
});

// --- Rotas Adicionais (Ex: para o frontend obter dados) ---
app.get('/api/conversations', (req, res) => {
  res.json(Object.values(conversations));
});

// --- Conexão Socket.IO ---
io.on('connection', (socket) => {
  console.log('Frontend conectado:', socket.id);

  // Envia conversas existentes para o novo cliente conectado
  socket.emit('initial_conversations', Object.values(conversations));

  // Lidar com atualização de anotações vinda do frontend
  socket.on('update_notes', ({ userId, notes }) => {
    if (conversations[userId]) {
      conversations[userId].notes = notes;
      console.log(`Notas atualizadas para ${userId}`);
      // Não precisa notificar outros clientes sobre notas, talvez?
      // Ou notificar apenas se for colaborativo: io.emit('notes_updated', { userId, notes });
    } else {
      console.warn(`Tentativa de atualizar notas para usuário inexistente: ${userId}`);
    }
  });

  // Lidar com mudança de status vinda do frontend (atendente moveu)
  socket.on('change_status', ({ userId, newStatus }) => {
    if (conversations[userId]) {
      conversations[userId].status = newStatus;
      console.log(`Status alterado para ${userId}: ${newStatus}`);
      // Notifica todos os frontends sobre a mudança de status
      io.emit('status_changed', { userId, newStatus });
    } else {
      console.warn(`Tentativa de mudar status para usuário inexistente: ${userId}`);
    }
  });

  // Lidar com envio de mensagem pelo atendente
  socket.on('send_agent_message', async ({ userId, text }) => {
    console.log(`Atendente enviando mensagem para ${userId}: ${text}`);
    if (conversations[userId]) {
      const messagePayload = { type: 'text', text: { body: text } };
      const sentMessageInfo = await sendWhatsAppMessage(userId, messagePayload);

      if (sentMessageInfo && sentMessageInfo.messages && sentMessageInfo.messages[0]) {
        const messageId = sentMessageInfo.messages[0].id;
        const newMessage = { sender: 'agent', text: text, timestamp: new Date(), id: messageId };
        conversations[userId].messages.push(newMessage);
        // Notifica todos os frontends sobre a nova mensagem do agente
        io.emit('new_message', { userId, message: newMessage });
      } else {
        console.error(`Falha ao enviar mensagem do agente para ${userId}`);
        // Opcional: notificar o frontend sobre a falha
        socket.emit('agent_message_failed', { userId, text });
      }
    } else {
      console.warn(`Tentativa de enviar mensagem para usuário inexistente: ${userId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Frontend desconectado:', socket.id);
  });
});

// --- Iniciar o Servidor ---
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor backend rodando na porta ${PORT}`);
  console.log(`Webhook esperado em http://localhost:${PORT}/webhook/whatsapp`);
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_VERIFY_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !APP_SECRET) {
    console.warn('\n*** ATENÇÃO: Variáveis de ambiente do WhatsApp (WHATSAPP_ACCESS_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_NUMBER_ID, APP_SECRET) não estão totalmente configuradas. A integração com a API real não funcionará. ***\n');
  }
});

