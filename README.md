# Aplicativo de Medição e Acompanhamento de Obras

Aplicativo web/PWA para planejamento semanal, medição física e acompanhamento de obras. O sistema centraliza cronograma, progresso por pavimento, PPC, motivos de atraso, histórico de execução e comunicação com equipes de campo.

## Principais Recursos

- Cadastro e seleção de projetos de obra.
- Importação de cronograma por Excel, XLS ou CSV.
- Controle de atividades por pavimento, macroatividade, serviço e equipe.
- Planejamento semanal com meta, dias previstos, avanço executado, atraso e observações.
- Fechamento semanal com gravação de PPC.
- Dashboard gerencial com indicadores, evolução e atrasos.
- Matriz geral de progresso por pavimento e etapa.
- Detalhamento de PPC por equipe/empreiteiro.
- Link de apontamento para equipes de campo via WhatsApp.
- Configuração de cidade e chave da Visual Crossing Weather API para clima.
- Análise gerencial por IA via Gemini, quando configurada.
- Estrutura PWA com manifesto e service worker simples para produção.

## Tecnologias

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Firebase Auth e Firestore
- SheetJS `xlsx` para importação de planilhas

## Requisitos

- Node.js compatível com as versões usadas no `package-lock.json`.
- Projeto Firebase com Authentication e Firestore habilitados.
- Opcional: chave Gemini para análise por IA.
- Opcional: chave Visual Crossing para previsão do tempo.

## Configuração Local

1. Instale as dependências:

```bash
npm ci
```

2. Copie `.env.example` para `.env.local`.

3. Preencha `VITE_FIREBASE_CONFIG` com o JSON de configuração do Firebase.

4. Rode em desenvolvimento:

```bash
npm run dev
```

5. Gere build de produção:

```bash
npm run build
```

6. Visualize o build:

```bash
npm run preview
```

## Variáveis de Ambiente

```env
VITE_FIREBASE_CONFIG={...}
VITE_APP_ID=obra-app
VITE_INITIAL_AUTH_TOKEN=
VITE_GEMINI_API_KEY=
```

`VITE_FIREBASE_CONFIG` é obrigatório para persistência. Sem ele, o aplicativo não consegue inicializar o Firebase corretamente.

`VITE_GEMINI_API_KEY` é opcional e habilita a análise gerencial por IA.

A chave da Visual Crossing é cadastrada pela tela de Configurações do próprio aplicativo.

## Fluxo de Uso

1. Acesse a tela inicial e selecione ou cadastre um projeto.
2. Importe o cronograma na aba `Cronograma`.
3. Revise pavimentos, macroatividades, serviços e equipes.
4. Monte o planejamento na aba `Planejamento Semanal`.
5. Envie tarefas para as equipes pelo botão de WhatsApp.
6. Receba ou registre os avanços físicos da semana.
7. Finalize a semana para gravar o PPC histórico.
8. Acompanhe os indicadores no painel, matriz e histórico.

## Observações de Segurança

O pacote `xlsx` possui avisos conhecidos de segurança sem correção disponível na versão pública usada atualmente. Recomendações:

- Importe apenas planilhas de origem confiável.
- Evite expor importação de arquivos para usuários anônimos sem controle.
- Avalie migração futura para uma alternativa mantida ou processamento de planilhas no backend.

## Estrutura Principal

- `src/App.tsx`: aplicação principal e regras de negócio.
- `src/main.tsx`: bootstrap React.
- `src/registerServiceWorker.ts`: registro do service worker.
- `src/index.css`: Tailwind e utilitários globais.
- `public/manifest.webmanifest`: manifesto PWA.
- `public/sw.js`: cache básico para produção.

## Validação

Comandos úteis:

```bash
npm run build
npm run lint
npm run audit:prod
```

## Deploy no Firebase Hosting

O projeto já inclui `firebase.json` e `.firebaserc` configurados para o projeto Firebase `aplicativovscode`.

1. Faça login na Firebase CLI:

```bash
npm run firebase -- login
```

2. Gere o build e publique no Hosting:

```bash
npm run deploy
```

3. Se precisar trocar o projeto Firebase padrão:

```bash
npm run firebase -- use --add
```

O deploy publica a pasta `dist`, gerada pelo Vite. As rotas são redirecionadas para `index.html`, o que permite funcionamento correto como SPA.

## Deploy no Netlify

O projeto também inclui `netlify.toml`, configurado para publicar a pasta `dist`.

Configurações no painel do Netlify:

- Build command: `npm run build`
- Publish directory: `dist`
- Node/package manager: npm

Em `Site configuration > Environment variables`, cadastre:

```env
VITE_FIREBASE_CONFIG={"apiKey":"...","authDomain":"...","projectId":"...","storageBucket":"...","messagingSenderId":"...","appId":"...","measurementId":"..."}
VITE_APP_ID=obra-app
VITE_INITIAL_AUTH_TOKEN=
VITE_GEMINI_API_KEY=
```

O redirect de SPA já está configurado para enviar rotas internas para `index.html`.
