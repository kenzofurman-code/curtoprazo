# Curto Prazo Piemonte

Este app registra planejamento semanal, medições físicas, PPC, cronogramas,
equipes e configurações de obras.

## Dados e cuidados

- Os dados permanecem no Firestore já usado pelo app, em
  `artifacts/obra-app/public/data/project_measurements`.
- O `appId` (`obra-app`) identifica o conjunto de dados existente. Não o troque
  nem altere a configuração do Firebase sem combinar a migração com a pessoa.
- Não leia, exporte, apague ou altere registros do Firestore ao trabalhar no
  código. As credenciais de conexão não ficam versionadas.
- A identidade e o papel da pessoa vêm assinados pelo Hub. `admin` pode
  administrar o cadastro e as permissões de obras; `equipe` usa e atualiza os
  dados de obra.
- Os links de apontamento de equipe abrem o próprio app. O Hub exige login para
  acessá-los; não torne caminhos públicos sem projetar uma autorização segura.
- O botão de WhatsApp apenas prepara um link para a pessoa abrir e enviar.

## Desenvolvimento

- Front-end em `src/` (React, TypeScript, Vite); servidor de publicação em
  `index.mjs`.
- `FIREBASE_CONFIG` é fornecido pelo ambiente do app e injetado na página pelo
  servidor. Não grave valores de configuração ou chaves em arquivos versionados.
- Use `npm run typecheck`, `npm run lint` e `node --test tests/*.test.mjs` para
  validar mudanças no front-end.
- A publicação roda `npm ci` e `npm run build` na cópia isolada do código.
