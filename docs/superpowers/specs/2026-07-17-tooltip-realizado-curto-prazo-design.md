# Tooltip do realizado no planejamento de curto prazo

## Objetivo

Exibir o percentual já executado de cada serviço no círculo cinza da coluna **Meta Planeada**, por meio de um tooltip, sem repetir essa informação na célula **Serviço / Pavimento**.

## Comportamento

- O círculo cinza continua representando a faixa visual de 25%, 50%, 75% ou 100% correspondente ao avanço anterior.
- Ao posicionar o ponteiro sobre esse círculo, o tooltip mostra o percentual exato no formato `X% já medido`.
- Percentuais decimais usam a formatação brasileira, por exemplo: `37,5% já medido`.
- O círculo verde continua tendo prioridade visual quando a faixa executada coincide com a meta planejada.
- Os demais círculos mantêm o tooltip de ação `Planejar X%`.
- A célula **Serviço / Pavimento** não exibe o percentual já medido.

## Implementação

O botão que representa cada faixa da meta recebe o texto de tooltip calculado a partir do valor bruto de execução anterior. A função existente de formatação percentual será reutilizada. Não será criado estado adicional nem um componente de tooltip customizado.

## Verificação

- Testar um valor inteiro e um decimal de execução anterior.
- Confirmar que apenas o círculo cinza apresenta `X% já medido`.
- Confirmar que os círculos não executados continuam apresentando `Planejar X%`.
- Executar a verificação de tipos e a compilação do projeto.
