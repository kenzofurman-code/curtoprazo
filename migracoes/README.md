# Dados do Curto Prazo Piemonte

O app mantém os dados existentes no Firestore do Firebase, no caminho
`artifacts/obra-app/public/data/project_measurements`. Não há migração local
nem mudança de banco nesta integração com o Hub.

Não altere o `appId` padrão (`obra-app`) sem um plano explícito de migração:
ele faz parte do caminho usado para localizar os dados já existentes.
