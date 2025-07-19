import React, { useState, useEffect, useCallback, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import './App.css';

// --- Tipagem (em português) ---
interface Mensagem {
  id: string;
  remetente: 'cliente' | 'atendente';
  texto: string;
  timestamp: number;
}

interface Conversa {
  id: string; // Número do cliente
  nome: string;
  os: string;
  status: string; // 'abertura_chamado', 'informacoes_duvidas', 'chamado_em_processo', 'finalizado', 'aguardando_opcao_bot', etc.
  mensagens: Mensagem[];
  atendente: string | null;
  // notas: string; // REMOVIDO - Anotações agora são globais
}

interface EstadoConversas {
  [numeroCliente: string]: Conversa;
}

// URL do backend (ajuste se necessário)
const ENDERECO_BACKEND = "http://localhost:3001";
const LOCALSTORAGE_KEY_ANOTACOES = "anotacoes_atendente";

function App() {
  const [conversas, setConversas] = useState<EstadoConversas>({});
  const [conversaSelecionada, setConversaSelecionada] = useState<string | null>(null);
  const [mensagemInput, setMensagemInput] = useState('');
  // Anotações agora são um estado global, não ligado à conversa
  const [anotacoesInput, setAnotacoesInput] = useState<string>(() => {
    // Carrega anotações salvas do localStorage ao iniciar
    return localStorage.getItem(LOCALSTORAGE_KEY_ANOTACOES) || '';
  });
  const socketRef = useRef<Socket | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null); // Ref para a área de mensagens
  const timeoutAnotacoesRef = useRef<NodeJS.Timeout | null>(null); // Ref para o debounce de salvar anotações

  // --- Funções de Manipulação de Estado ---

  // Atualiza ou adiciona uma conversa inteira
  const atualizarOuAdicionarConversa = useCallback((dados: { numeroCliente: string; conversaCompleta: Conversa }) => {
    setConversas(prevConversas => {
      const { numeroCliente, conversaCompleta } = dados;
      return {
        ...prevConversas,
        [numeroCliente]: conversaCompleta // Não precisa mais garantir campo notas aqui
      };
    });
  }, []);

  const atualizarStatus = useCallback((dados: { numeroCliente: string; novoStatus: string }) => {
    setConversas(prevConversas => {
      const { numeroCliente, novoStatus } = dados;
      const conversaExistente = prevConversas[numeroCliente];
      if (conversaExistente) {
        return {
          ...prevConversas,
          [numeroCliente]: {
            ...conversaExistente,
            status: novoStatus
          }
        };
      }
      return prevConversas;
    });
  }, []);

  // --- Efeito para Conexão Socket.IO e Listeners ---
  useEffect(() => {
    socketRef.current = io(ENDERECO_BACKEND);
    const socket = socketRef.current;
    console.log(`Conectando ao backend em ${ENDERECO_BACKEND}...`);

    socket.on("connect", () => console.log("Conectado ao backend com ID:", socket.id));
    socket.on("disconnect", () => console.log("Desconectado do backend."));
    socket.on("connect_error", (err) => console.error("Erro de conexão com o backend:", err));
    socket.on("estado_inicial", (estadoInicial: EstadoConversas) => {
      console.log("Estado inicial recebido:", estadoInicial);
      setConversas(estadoInicial);
    });
    socket.on("atualizacao_conversa_completa", (dados) => {
      console.log("Atualização de conversa completa recebida:", dados);
      atualizarOuAdicionarConversa(dados);
    });
    socket.on("atualizacao_status", (dados) => {
      console.log("Atualização de status recebida:", dados);
      atualizarStatus(dados);
    });

    return () => {
      console.log("Desconectando do backend...");
      // Limpa o timeout ao desmontar para evitar salvar após sair
      if (timeoutAnotacoesRef.current) {
        clearTimeout(timeoutAnotacoesRef.current);
      }
      socket.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Efeito para rolar a área de chat para baixo ---
  useEffect(() => {
    if (chatAreaRef.current) {
      chatAreaRef.current.scrollTop = chatAreaRef.current.scrollHeight;
    }
  }, [conversas, conversaSelecionada]);

  // REMOVIDO: Efeito para atualizar anotações ao selecionar conversa
  // useEffect(() => {
  //   if (conversaSelecionada && conversas[conversaSelecionada]) {
  //     setAnotacoesInput(conversas[conversaSelecionada].notas || '');
  //   } else {
  //     setAnotacoesInput('');
  //   }
  // }, [conversaSelecionada, conversas]);

  // --- Funções de Interação do Usuário ---
  const handleSelecionarConversa = (numeroCliente: string) => {
    setConversaSelecionada(numeroCliente);
    // Não atualiza mais as anotações ao selecionar
  };

  const handleEnviarMensagem = () => {
    if (mensagemInput.trim() && conversaSelecionada && socketRef.current) {
      socketRef.current.emit("enviar_mensagem_atendente", {
        numeroCliente: conversaSelecionada,
        textoMensagem: mensagemInput
      });
      setMensagemInput('');
    }
  };

  const handleMudarStatus = (numeroCliente: string, novoStatus: string) => {
    if (socketRef.current) {
      socketRef.current.emit("mudar_status_conversa", {
        numeroCliente: numeroCliente,
        novoStatus: novoStatus
      });
    }
  };

  // Função para salvar anotações no localStorage (com debounce)
  const salvarAnotacoesLocal = (notas: string) => {
    console.log("Salvando anotações no localStorage...");
    localStorage.setItem(LOCALSTORAGE_KEY_ANOTACOES, notas);
  };

  const handleAnotacoesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const novasNotas = event.target.value;
    setAnotacoesInput(novasNotas);

    // Cancela o timeout anterior se existir
    if (timeoutAnotacoesRef.current) {
      clearTimeout(timeoutAnotacoesRef.current);
    }

    // Define um novo timeout para salvar no localStorage após 1 segundo de inatividade
    timeoutAnotacoesRef.current = setTimeout(() => {
      salvarAnotacoesLocal(novasNotas);
    }, 1000); // Reduzido para 1 segundo
  };

  // --- Renderização ---
  const conversasPorStatus: { [status: string]: Conversa[] } = {};
  Object.values(conversas).forEach(conv => {
    if (!conversasPorStatus[conv.status]) {
      conversasPorStatus[conv.status] = [];
    }
    conversasPorStatus[conv.status].push(conv);
  });

  const statusAbas = ["aguardando_opcao_bot", "abertura_chamado", "informacoes_duvidas", "chamado_em_processo", "finalizado"];
  const conversaAtual = conversaSelecionada ? conversas[conversaSelecionada] : null;

  return (
    <div className="App">
      <div className="container-principal-tres-colunas">
        {/* Coluna Esquerda: Abas */}
        <div className="coluna coluna-esquerda">
          <h2 className="titulo-coluna">Nome do Sistema</h2>
          <div className="container-abas">
            <h3>Status / Abas</h3>
            {statusAbas.map(status => (
              <div key={status} className="aba-container">
                <h4>{status.replace(/_/g, ' ').toUpperCase()} ({conversasPorStatus[status]?.length || 0})</h4>
                <ul className="lista-conversas">
                  {(conversasPorStatus[status] || []).map(conv => (
                    <li
                      key={conv.id}
                      className={conv.id === conversaSelecionada ? 'selecionada' : ''}
                      onClick={() => handleSelecionarConversa(conv.id)}
                    >
                      {conv.id} <span className="contador-msgs">({conv.mensagens.length})</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Coluna Central: Chat */}
        <div className="coluna coluna-central">
          <h2 className="titulo-coluna">Chat Ativo</h2>
          {conversaAtual ? (
            <div className="chat-ativo">
              <div className="info-chat">
                <span>Conversa com: <strong>{conversaAtual.id}</strong></span>
                <span>Status: <strong>{conversaAtual.status.replace(/_/g, ' ').toUpperCase()}</strong></span>
              </div>
              <div className="acoes-chat">
                <span>Mover para:</span>
                {statusAbas.filter(s => s !== conversaAtual.status).map(s => (
                  <button key={s} onClick={() => handleMudarStatus(conversaAtual.id, s)}>
                    {s.replace(/_/g, ' ').toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="area-mensagens" ref={chatAreaRef}>
                {conversaAtual.mensagens.map(msg => (
                  <div key={msg.id} className={`mensagem ${msg.remetente}`}>
                    <span className="remetente">{msg.remetente === 'cliente' ? 'Cliente' : 'Atendente'}:</span>
                    <span className="texto">{msg.texto}</span>
                    <span className="timestamp">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                ))}
              </div>
              <div className="area-input">
                <input
                  type="text"
                  value={mensagemInput}
                  onChange={(e) => setMensagemInput(e.target.value)}
                  placeholder="Digite sua mensagem..."
                  onKeyPress={(e) => e.key === 'Enter' && handleEnviarMensagem()}
                />
                <button onClick={handleEnviarMensagem}>Enviar</button>
              </div>
            </div>
          ) : (
            <p className="selecione-conversa">Selecione uma conversa na coluna à esquerda.</p>
          )}
        </div>

        {/* Coluna Direita: Anotações Fixas */}
        <div className="coluna coluna-direita">
          <h2 className="titulo-coluna">Bloco de Notas (Fixo)</h2>
          {/* Área de anotações agora é independente da conversa selecionada */}
          <textarea
            className="area-anotacoes"
            placeholder="Digite suas anotações gerais aqui... Elas ficarão salvas no seu navegador."
            value={anotacoesInput}
            onChange={handleAnotacoesChange}
          />
        </div>
      </div>
    </div>
  );
}

export default App;

