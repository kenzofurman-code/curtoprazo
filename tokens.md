Piemonte · Sistema de estilo
alternar tema
Tokens Piemonte
Uma camada única de cor, tipografia e componentes para qualquer área produzir manuais, relatórios e páginas com a mesma identidade — sem redesenhar nada e sem copiar hexadecimal de lugar nenhum.

v1.0
piemonte-tokens.css
piemonte-doc.css
tema claro + escuro
Conteúdo

O que é
Como usar
Cores
Semânticas
Tipografia
Componentes
Regras de uso
Arquivos
O que é

Uma fonte só para a identidade
Cada material que produzimos vinha carregando a sua própria cópia das cores e dos estilos. Quando a marca muda — ou quando alguém erra um tom por um dígito — não há como corrigir tudo de uma vez. O token de estilo resolve isso: as cores, as fontes e os espaçamentos passam a viver em um arquivo só, e todo material aponta para ele.

Na prática você nunca mais escreve #1A665B num documento. Escreve var(--accent), e o arquivo decide o que isso significa — inclusive no modo escuro, que passa a funcionar sozinho.

Esta página é o próprio sistema em uso. Tudo o que você está vendo — o índice à esquerda, as cores, os blocos — vem dos dois arquivos descritos aqui. Use o botão alternar tema lá em cima para ver a camada trabalhando.

Como usar

Dois caminhos
1. Página hospedada — site, intranet, app
Referencie os arquivos direto. É o caminho preferido: quando os tokens forem atualizados, seu material acompanha sem você mexer em nada.

<link rel="stylesheet" href="https://piemonte.app/estilo/piemonte-tokens.css">
<link rel="stylesheet" href="https://piemonte.app/estilo/piemonte-doc.css">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
A ordem importa: os tokens vêm antes da folha de documento.

2. Documento isolado — artefato do Claude, e-mail, arquivo avulso
Aqui o <link> acima não funciona. Artefatos bloqueiam CSS externo por segurança, e um arquivo solto enviado por e-mail perde a referência. Nesses casos o conteúdo precisa viajar junto com a página.

Atalho
Peça ao Claude: “use os tokens de piemonte.app/estilo/piemonte-tokens.css”. Ele busca o arquivo e cola o bloco no documento. É mais rápido do que copiar à mão.

Se preferir fazer manualmente, o arquivo inteiro está logo abaixo — cole dentro de uma tag <style> no topo da página.

▸ piemonte-tokens.css — conteúdo completo
Cores

Paleta
Os valores abaixo saíram do uso real no Dashboard de Mercado, não de uma paleta inventada: o verde-petróleo aparece em mais de trezentos pontos do código, o verde vivo em cento e cinquenta. Clique em qualquer amostra para copiar o nome da variável.

Verde Piemonte

Verde 50
--pm-50
#EAF5F0

Verde 100
--pm-100
#D2E8DE

Verde 200
--pm-200
#A3C6B8

Verde 400
--pm-400
#5CAA8A

Verde vivo
--pm-500
#00B871

Verde-petróleo
--pm-600
#1A665B

Verde 700
--pm-700
#153D36

Verde 800
--pm-800
#143F38

Verde 900
--pm-900
#0E2E29
Os tons --pm-50 e --pm-100 são derivados: a paleta institucional não tinha versão clara, e ela é necessária para fundos de destaque.

Neutros

Areia
--pm-areia
#E6E2DA

Branco
--pm-branco
#FFFFFF

Cinza 50
--pm-cinza-50
#F6F7F5

Cinza 100
--pm-cinza-100
#F0F0F0

Cinza 200
--pm-cinza-200
#E5E7EB

Cinza 400
--pm-cinza-400
#9CA3AF

Cinza 500
--pm-cinza-500
#64748B

Cinza 800
--pm-cinza-800
#1F2937

Cinza 900
--pm-cinza-900
#151A21
Sinalização

Sucesso
--pm-sucesso
#10B981

Atenção
--pm-atencao
#F59E0B

Erro
--pm-erro
#EF4444

Informação
--pm-info
#2563EB
Séries de gráfico
Use nesta ordem. As três primeiras carregam a marca; as seguintes entram só quando a série exige mais categorias.


Série 1
--pm-serie-1
#1A665B

Série 2
--pm-serie-2
#00B871

Série 3
--pm-serie-3
#2563EB

Série 4
--pm-serie-4
#F59E0B

Série 5
--pm-serie-5
#7C3AED

Série 6
--pm-serie-6
#DB2777

Série 7
--pm-serie-7
#EA580C

Série 8
--pm-serie-8
#5CAA8A
Semânticas

É isto que você usa
As cores da seção anterior são a matéria-prima. No material, use sempre os nomes abaixo — eles dizem o papel da cor, não a cor em si, e é o que faz o tema escuro funcionar sem trabalho extra.

Variável	Papel	Onde entra
--bg	Fundo da página	O plano mais ao fundo
--surface	Superfície elevada	Cartões, caixas, tabelas
--surface-2	Superfície recuada	Cabeçalho de tabela, campo inativo
--ink	Texto principal	Títulos e destaques
--ink-2	Texto corrente	Parágrafos e listas
--muted	Texto secundário	Legendas, rótulos, rodapé
--border	Divisor	Bordas e linhas de tabela
--accent	Destaque da marca	Links, item ativo, ênfase
--accent-soft	Fundo do destaque	Item selecionado, aviso neutro
--ok --warn --danger	Estado	Sucesso, atenção, erro
--code-bg --code-ink	Código	Blocos técnicos
Por que importa
Cada uma dessas variáveis já tem o par definido para o tema escuro. Se o material usa só esses nomes, ele nasce funcionando nos dois temas — e ninguém precisa lembrar disso.

Tipografia

Duas fontes, seis tamanhos
Atenção
A fonte institucional da Piemonte é a Gravity, mas ela é de uso impresso e não existe como fonte web. No digital a substituta oficial é a Inter — a mesma que o dashboard usa. Material impresso continua em Gravity.

--fs-2xl
Inter 700
Inteligência de Mercado
--fs-xl
Inter 700
Título de seção
--fs-lg
Inter 600
Subtítulo dentro da seção
--fs-base
Inter 400
Texto corrente, com largura limitada a 70 caracteres para leitura confortável.
--fs-sm
Inter 400
Legenda, rodapé e texto de apoio
--fs-xs
IBM Plex Mono
Rótulo · dado · código
A monoespaçada (--mono) não é decoração: ela marca o que é dado ou comando — nomes de variável, caminhos de arquivo, rótulos de tabela. Manter essa separação é o que deixa o material legível sem precisar de cor.

Componentes

Blocos prontos
Vêm de piemonte-doc.css. Você escreve a classe, o estilo já está resolvido.

Cartão
Agrupa uma ideia fechada. Classe .card.

Destaques
Nota
Contexto útil, sem urgência. .note

Certo
Confirmação ou boa prática. .note.ok

Atenção
Cuidado necessário. .note.warn

Cuidado
Risco de perda ou erro grave. .note.danger

Tabela
Classe	Serve para
.tbl	Envolve a tabela e permite rolagem lateral no celular
.pill	Etiqueta curta de metadado
.eyebrow	Rótulo acima do título da seção
.lede	Parágrafo de abertura, maior que o corpo
Estrutura da página
O esqueleto — abertura, índice fixo à esquerda, conteúdo à direita, rodapé — está comentado no topo de piemonte-doc.css. Copie de lá e troque o conteúdo.

Regras de uso

Três coisas que quebram o sistema
Escrever a cor em vez do papel
faça
.titulo { color: var(--ink); }
.link   { color: var(--accent); }
evite
.titulo { color: #151A21; }
.link   { color: #1A665B; }
O hexadecimal cru some do tema escuro e não acompanha revisões da marca. É o erro que desfaz o sistema inteiro.

Definir cor só dentro do bloco escuro
Toda cor precisa nascer no :root claro e ser redefinida no escuro. Uma cor que só existe dentro do @media simplesmente não aparece para quem está no tema claro — e o resultado é texto invisível.

Inventar um tom novo
Se faltar uma cor, ela provavelmente já existe com outro nome. Antes de criar, procure na paleta. Se realmente não existir, avise para entrar na próxima versão do arquivo em vez de ficar só no seu material.

Arquivos

Onde tudo vive
Arquivo	Contém	Endereço
piemonte-tokens.css	Cores, fontes, escalas, temas	/estilo/piemonte-tokens.css
piemonte-doc.css	Componentes de documento	/estilo/piemonte-doc.css
Os dois ficam em public/estilo/ no repositório do Dashboard de Mercado e são servidos a partir de piemonte.app. Quem mantém: Inteligência de Mercado.

Mudanças
Alteração em token é alteração em todo material que aponta para ele. Pedidos de cor ou componente novo passam por quem mantém o arquivo, e a versão no topo sobe junto.

Tokens Piemonte v1.0 · setembro de 2026 · mantido por Inteligência de Mercado. Esta página foi construída com os próprios arquivos que documenta.   