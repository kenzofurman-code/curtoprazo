import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nome = 'curto-prazo-piemonte';
const base = (process.env.HUB_BASE || process.env.RATOEIRA_BASE || `/${nome}`).replace(/\/$/, '');
const aqui = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(process.env.AMBIENTE || aqui, process.env.AMBIENTE ? 'curtoprazo/dist' : 'dist');
const indexFile = path.join(buildDir, 'index.html');
const porta = Number(process.env.PORTA || 8797);
const maximoBytes = 5 * 1024 * 1024;

const tipos = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function segredo() {
  if (process.env.HUB_APP_SECRET) return process.env.HUB_APP_SECRET;
  const diretorio = process.env.CREDENTIALS_DIRECTORY;
  if (diretorio) {
    for (const arquivo of ['hub-segredo', 'ratoeira-segredo']) {
      try { return fs.readFileSync(path.join(diretorio, arquivo), 'utf8').trim(); } catch { /* tenta o próximo */ }
    }
  }
  if (process.env.NODE_ENV !== 'production') return process.env.RATOEIRA_TEST_SECRET || '';
  return '';
}

function lerConfigFirebase() {
  const bruto = process.env.FIREBASE_CONFIG || process.env.VITE_FIREBASE_CONFIG;
  if (!bruto) return null;
  try {
    const config = JSON.parse(bruto);
    const obrigatorios = ['apiKey', 'authDomain', 'projectId', 'appId'];
    return config && typeof config === 'object' && obrigatorios.every(campo => typeof config[campo] === 'string' && config[campo])
      ? config
      : null;
  } catch {
    return null;
  }
}

function jsonSeguro(valor) {
  return JSON.stringify(valor)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function enviar(res, status, tipo, corpo) {
  res.writeHead(status, {
    'content-type': tipo,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });
  res.end(corpo);
}

function falha(res, status, mensagem) {
  enviar(res, status, 'text/plain; charset=utf-8', mensagem);
}

function decodificarIdentidade(req) {
  const raw = req.headers['x-hub-identidade'] || req.headers['x-ratoeira-identidade'];
  if (typeof raw !== 'string') return null;
  const ponto = raw.indexOf('.');
  if (ponto < 1 || ponto === raw.length - 1) return null;

  const payload = raw.slice(0, ponto);
  const assinatura = raw.slice(ponto + 1);
  const chave = segredo();
  if (!chave) return null;

  const esperada = crypto.createHmac('sha256', chave).update(payload).digest('base64url');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const identidade = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof identidade.email !== 'string' ||
      typeof identidade.nome !== 'string' ||
      identidade.app !== base ||
      !['admin', 'equipe'].includes(identidade.papel) ||
      typeof identidade.exp !== 'number' ||
      identidade.exp < Date.now() / 1000
    ) return null;
    return identidade;
  } catch {
    return null;
  }
}

function caminhoDaRequisicao(req) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function rotaInterna(caminho) {
  if (caminho === '/saude' || caminho === `${base}/saude`) return '/saude';
  if (caminho === base || caminho === `${base}/`) return '/';
  if (caminho.startsWith(`${base}/`)) return caminho.slice(base.length);
  return null;
}

function htmlComContexto(identidade, configFirebase) {
  const html = fs.readFileSync(indexFile, 'utf8');
  const contexto = `<script>window.__ratoeira_identidade=${jsonSeguro(identidade)};window.__ratoeira_base=${jsonSeguro(`${base}/`)};window.__firebase_config=${jsonSeguro(JSON.stringify(configFirebase))};window.__app_id="obra-app";</script><script src="/_ratoeira/app.js"></script>`;
  return html.replace('</head>', `${contexto}</head>`);
}

function resolverArquivo(rota) {
  const arquivo = path.resolve(buildDir, `.${rota}`);
  return arquivo.startsWith(`${buildDir}${path.sep}`) ? arquivo : null;
}

const servidor = http.createServer((req, res) => {
  const caminho = caminhoDaRequisicao(req);
  if (!caminho) return falha(res, 400, 'Caminho inválido.');
  const rota = rotaInterna(caminho);
  if (!rota) return falha(res, 404, 'Não encontrado.');

  if (rota === '/saude') {
    const buildPronto = fs.existsSync(indexFile);
    const firebasePronto = lerConfigFirebase() !== null;
    const identidadePronta = segredo() !== '';
    const ok = buildPronto && firebasePronto && identidadePronta;
    if (!ok) console.error(`Saúde pendente: build=${buildPronto}, firebase=${firebasePronto}, identidade=${identidadePronta}`);
    return falha(res, ok ? 200 : 503, ok ? 'ok' : 'Configure FIREBASE_CONFIG e gere o build antes de publicar.');
  }

  const identidade = decodificarIdentidade(req);
  if (!identidade) return falha(res, 401, 'Abra pelo Hub.');
  if (!['GET', 'HEAD'].includes(req.method || '')) return falha(res, 405, 'Método não permitido.');
  if (req.headers['content-length'] && Number(req.headers['content-length']) > maximoBytes) {
    return falha(res, 413, 'Arquivo grande demais.');
  }
  if (!fs.existsSync(indexFile)) return falha(res, 503, 'O app ainda não foi preparado para publicação.');

  const configFirebase = lerConfigFirebase();
  if (!configFirebase) return falha(res, 503, 'Falta configurar a conexão Firebase do Curto Prazo Piemonte.');

  if (rota === '/') {
    const html = htmlComContexto(identidade, configFirebase);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  const arquivo = resolverArquivo(rota);
  if (!arquivo) return falha(res, 404, 'Não encontrado.');
  let stats;
  try {
    stats = fs.statSync(arquivo);
  } catch {
    if (!path.extname(rota)) {
      const html = htmlComContexto(identidade, configFirebase);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : html);
    }
    return falha(res, 404, 'Não encontrado.');
  }
  if (!stats.isFile()) return falha(res, 404, 'Não encontrado.');

  const tipo = tipos.get(path.extname(arquivo).toLowerCase()) || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': tipo,
    'content-length': stats.size,
    'cache-control': path.basename(arquivo) === 'index.html' ? 'no-store' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(arquivo).pipe(res);
});

servidor.listen(porta, '127.0.0.1', () => {
  const endereco = servidor.address();
  const portaAtiva = typeof endereco === 'object' && endereco ? endereco.port : porta;
  console.log(`Curto Prazo Piemonte ativo em 127.0.0.1:${portaAtiva}`);
});
