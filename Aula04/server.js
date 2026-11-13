// ---------- BLOCO 1: configuração ----------
const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const PORTA = 3003;
const URL_OLLAMA = 'http://localhost:11434/api/chat';
const MODELO = 'qwen2.5:3b';

const LIMITE_HISTORICO = 20;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PROMPT_SISTEMA = `Você é o atendente virtual de uma loja de informática.
Responda sempre em português, de forma curta.
Para qualquer pergunta sobre produtos, clientes ou pedidos, use sempre uma ferramenta antes de responder.
Nunca invente dados: responda apenas com o que as ferramentas devolverem.
Liste todos os itens que a ferramenta devolver, sem pular nenhum.
Se a ferramenta devolver uma lista vazia, diga que a loja não tem.
Lembre do que o cliente já disse nesta conversa (nome, preferências) e use isso nas respostas.`;

// ---------- BLOCO 2: banco e funções de memória ----------
const banco = mysql.createPool({
  host: 'localhost',
  user: 'aluno',
  password: 'aluno123',
  database: 'loja_ia'
});

async function lerHistorico(conversa) {
  const [linhas] = await banco.query(
    `SELECT role, content, criado_em FROM (
       SELECT id, role, content, criado_em FROM mensagens
       WHERE conversa = ? ORDER BY id DESC LIMIT ?
     ) AS ultimas ORDER BY id`,
    [conversa, LIMITE_HISTORICO]
  );
  return linhas;
}

async function salvarMensagem(conversa, role, content) {
  await banco.query(
    'INSERT INTO mensagens (conversa, role, content) VALUES (?, ?, ?)',
    [conversa, role, content]
  );
}

// ---------- BLOCO 3: funções e ferramentas ----------
const funcoes = {
  listar_produtos: async (args) => {
    let sql = 'SELECT * FROM produtos WHERE 1 = 1';
    const valores = [];
    if (args.categoria) {
      sql += ' AND categoria = ?';
      valores.push(args.categoria);
    }
    if (args.sem_estoque) sql += ' AND estoque = 0';
    const [linhas] = await banco.query(sql, valores);
    return linhas;
  },
  listar_clientes: async (args) => {
    if (args.cidade) {
      const [linhas] = await banco.query('SELECT * FROM clientes WHERE cidade = ?', [args.cidade]);
      return linhas;
    }
    const [linhas] = await banco.query('SELECT * FROM clientes');
    return linhas;
  },
  listar_pedidos: async (args) => {
    const [linhas] = await banco.query(`
      SELECT
        pedidos.id,
        clientes.nome AS cliente,
        produtos.nome AS produto,
        pedidos.quantidade,
        produtos.preco * pedidos.quantidade AS total,
        DATE_FORMAT(pedidos.data_pedido, '%Y-%m-%d') AS data_pedido,
        pedidos.status
      FROM pedidos
      JOIN clientes ON clientes.id = pedidos.cliente_id
      JOIN produtos ON produtos.id = pedidos.produto_id
      WHERE ? IS NULL OR pedidos.status = ?
      ORDER BY pedidos.id
    `, [args.status || null, args.status || null]);
    return linhas;
  }
};

const ferramentas = [
  {
    type: 'function',
    function: {
      name: 'listar_produtos',
      description: 'Lista os produtos da loja com nome, categoria, preço e estoque. Estoque 0 significa produto em falta.',
      parameters: {
        type: 'object',
        properties: {
          categoria: {
            type: 'string',
            description: 'Opcional. Filtra por categoria: Periféricos, Áudio, Monitores, Armazenamento, Computadores ou Móveis.'
          },
          sem_estoque: {
            type: 'boolean',
            description: 'Opcional. Use true para trazer só os produtos em falta (estoque 0).'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_clientes',
      description: 'Lista os clientes da loja com nome, email e cidade.',
      parameters: {
        type: 'object',
        properties: {
          cidade: {
            type: 'string',
            description: 'Opcional. Traz só os clientes desta cidade.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_pedidos',
      description: 'Lista os pedidos com nome do cliente, produto, quantidade, total, data e status.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pendente', 'enviado', 'entregue', 'cancelado'],
            description: 'Opcional. Traz só os pedidos com este status.'
          }
        }
      }
    }
  }
];

// ---------- BLOCO 4: laço do agente ----------
async function rodarAgente(mensagens) {
  const usadas = [];

  for (let volta = 0; volta < 5; volta++) {
    const resposta = await fetch(URL_OLLAMA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODELO, messages: mensagens, tools: ferramentas, stream: false })
    });
    if (!resposta.ok) throw new Error('Ollama respondeu HTTP ' + resposta.status);

    const mensagem = (await resposta.json()).message;
    mensagens.push(mensagem);

    if (!mensagem.tool_calls) {
      return { resposta: mensagem.content, ferramentas: usadas };
    }

    for (const chamada of mensagem.tool_calls) {
      const nome = chamada.function.name;
      const funcao = funcoes[nome];
      const resultado = funcao
        ? await funcao(chamada.function.arguments || {})
        : { erro: 'Ferramenta ' + nome + ' não existe' };

      console.log('Ferramenta:', nome, JSON.stringify(chamada.function.arguments));
      usadas.push(nome);
      mensagens.push({ role: 'tool', tool_name: nome, content: JSON.stringify(resultado) });
    }
  }

  return { resposta: 'Não consegui chegar a uma resposta.', ferramentas: usadas };
}

// ---------- BLOCO 5: validação ----------
function entradaValida(conversa, texto) {
  return typeof conversa === 'string' && conversa.length > 0 && conversa.length <= 36
    && typeof texto === 'string' && texto.trim().length > 0 && texto.length <= 2000;
}

// ---------- BLOCO 6: rotas ----------

// Lista todas as conversas salvas na memória com título baseado na 1ª mensagem e data/hora
app.get('/conversas', async (req, res) => {
  const [linhas] = await banco.query(`
    SELECT 
      conversa,
      SUBSTRING(MIN(CASE WHEN role = 'user' THEN content END), 1, 45) AS titulo,
      MAX(criado_em) AS data_hora
    FROM mensagens
    GROUP BY conversa
    ORDER BY MAX(id) DESC
  `);
  res.json(linhas);
});

app.get('/historico/:conversa', async (req, res) => {
  res.json(await lerHistorico(req.params.conversa));
});

app.post('/chat', async (req, res) => {
  const { conversa, texto } = req.body;
  if (!entradaValida(conversa, texto)) {
    return res.status(400).json({ erro: 'Envie conversa e texto.' });
  }

  const historico = await lerHistorico(conversa);
  const textoHistorico = historico
    .map((m) => (m.role === 'user' ? 'Cliente: ' : 'Atendente: ') + m.content)
    .join('\n');
  const mensagens = [
    { role: 'system', content: PROMPT_SISTEMA + (historico.length ? '\n\nConversa até agora:\n' + textoHistorico : '') },
    { role: 'user', content: texto }
  ];
  const resultado = await rodarAgente(mensagens);
  await salvarMensagem(conversa, 'user', texto);
  await salvarMensagem(conversa, 'assistant', resultado.resposta);

  res.json(resultado);
});

app.use((erro, req, res, next) => {
  console.error(erro.message);
  res.status(500).json({ erro: 'Falha no servidor: ' + erro.message });
});

app.listen(PORTA, () => {
  console.log('Agente com memória no ar: http://localhost:' + PORTA);
});