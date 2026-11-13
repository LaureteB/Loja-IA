const chat = document.getElementById('chat');
const form = document.getElementById('form');
const pergunta = document.getElementById('pergunta');
const enviar = document.getElementById('enviar');
const nova = document.getElementById('nova');
const listaConversas = document.getElementById('lista-conversas');

let conversa = localStorage.getItem('conversa');
if (!conversa) {
  conversa = crypto.randomUUID();
  localStorage.setItem('conversa', conversa);
}

// Formata hora (HH:MM) a partir de uma data do banco ou da hora atual
function formatarHora(dataStr) {
  const data = dataStr ? new Date(dataStr) : new Date();
  if (isNaN(data.getTime())) return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Formata data e hora para a barra lateral
function formatarDataHora(dataStr) {
  if (!dataStr) return '';
  const data = new Date(dataStr);
  if (isNaN(data.getTime())) return '';
  return data.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' às ' +
    data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function mostrar(classe, texto, dataHora = null, statusTexto = null) {
  if (classe === 'ferramentas') {
    const divFerramenta = document.createElement('div');
    divFerramenta.className = 'ferramentas';
    divFerramenta.textContent = texto;
    chat.appendChild(divFerramenta);
    chat.scrollTop = chat.scrollHeight;
    return divFerramenta;
  }

  const isUser = classe.includes('user');
  const wrapper = document.createElement('div');
  wrapper.className = `msg-wrapper ${isUser ? 'user' : 'assistant'}`;

  // Cabeçalho da mensagem: Identificação + Horário
  const cabecalho = document.createElement('div');
  cabecalho.className = 'msg-cabecalho';

  const badge = document.createElement('span');
  badge.className = 'avatar-badge';
  badge.textContent = isUser ? 'Você' : 'IA Ollama';

  const horaSpan = document.createElement('span');
  horaSpan.className = 'msg-hora';
  horaSpan.textContent = formatarHora(dataHora);

  cabecalho.appendChild(badge);
  cabecalho.appendChild(horaSpan);

  // Balão de texto
  const bolha = document.createElement('div');
  bolha.className = 'msg-bolha';
  bolha.textContent = texto;

  // Rodapé de status (ex: Enviada / Respondido pela IA)
  const statusSpan = document.createElement('div');
  statusSpan.className = 'msg-status-envio';
  statusSpan.textContent = statusTexto || (isUser ? '✓ Mensagem enviada' : '✦ Resposta da IA');

  wrapper.appendChild(cabecalho);
  wrapper.appendChild(bolha);
  wrapper.appendChild(statusSpan);

  chat.appendChild(wrapper);
  chat.scrollTop = chat.scrollHeight;

  // Retorna referências para atualizar o balão quando a IA responder
  return { bolha, statusSpan, horaSpan };
}

// Carrega a lista de chats guardados na memória (MySQL) para a barra lateral
async function carregarListaConversas() {
  try {
    const resposta = await fetch('/conversas');
    if (!resposta.ok) return;
    const conversas = await resposta.json();

    listaConversas.innerHTML = '';

    if (conversas.length === 0) {
      listaConversas.innerHTML = '<div style="font-size:12px; color:#94a3b8; padding:8px;">Nenhuma conversa salva ainda.</div>';
      return;
    }

    for (const item of conversas) {
      const card = document.createElement('div');
      card.className = 'item-conversa' + (item.conversa === conversa ? ' ativa' : '');

      const titulo = document.createElement('div');
      titulo.className = 'conv-titulo';
      titulo.textContent = item.titulo || 'Conversa sem título';
      titulo.title = item.titulo;

      const meta = document.createElement('div');
      meta.className = 'conv-meta';
      meta.textContent = formatarDataHora(item.data_hora);

      card.appendChild(titulo);
      card.appendChild(meta);

      // Função de voltar ao chat guardado na memória ao clicar
      card.addEventListener('click', () => {
        if (conversa === item.conversa) return;
        conversa = item.conversa;
        localStorage.setItem('conversa', conversa);
        chat.innerHTML = '';
        carregarHistorico();
        carregarListaConversas();
      });

      listaConversas.appendChild(card);
    }
  } catch (erro) {
    console.error('Erro ao listar conversas:', erro);
  }
}

// Ao abrir a página: busca o que já foi conversado e mostra na tela
async function carregarHistorico() {
  try {
    const resposta = await fetch('/historico/' + conversa);
    const mensagens = await resposta.json();
    if (!resposta.ok) throw new Error(mensagens.erro);
    for (const m of mensagens) {
      mostrar('msg ' + m.role, m.content, m.criado_em);
    }
  } catch (erro) {
    mostrar('msg assistant', 'Erro ao carregar o histórico: ' + erro.message);
  }
}

carregarHistorico();
carregarListaConversas();

nova.addEventListener('click', () => {
  conversa = crypto.randomUUID();
  localStorage.setItem('conversa', conversa);
  chat.textContent = '';
  carregarListaConversas();
  pergunta.focus();
});

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  const texto = pergunta.value.trim();
  if (!texto) return;

  mostrar('msg user', texto, new Date(), '✓ Enviada agora');
  pergunta.value = '';
  enviar.disabled = true;

  const balaoIA = mostrar('msg assistant', 'Digitando resposta...', new Date(), '⏳ IA processando...');

  try {
    const resposta = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversa: conversa, texto: texto })
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.erro);

    balaoIA.bolha.textContent = dados.resposta;
    balaoIA.horaSpan.textContent = formatarHora(new Date());
    balaoIA.statusSpan.textContent = '✦ Enviada pela IA';

    if (dados.ferramentas.length > 0) {
      mostrar('ferramentas', 'Consultou: ' + dados.ferramentas.join(', '));
    }

    // Atualiza a barra lateral para exibir o chat com título e data/hora
    carregarListaConversas();
  } catch (erro) {
    balaoIA.bolha.textContent = 'Erro: ' + erro.message;
    balaoIA.statusSpan.textContent = '⚠️ Falha no envio';
  }
  enviar.disabled = false;
  pergunta.focus();
});