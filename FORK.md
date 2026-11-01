# Free My TV, com Canais e Torrents

Fork do [Free My TV](https://github.com/simbasjungles/free-my-tv): uma tela inicial sem anúncios para TVs LG (webOS) e
Samsung (Tizen), instalada pelo Modo Desenvolvedor, sem root e sem alterar o sistema da TV. Este fork adiciona canais
abertos e reprodução de torrents à tela inicial, no mesmo código que roda nas duas marcas.

## O que este fork adiciona

**Canais (IPTV).** Um app na fileira da tela inicial que lista os canais públicos do país pela lista do
[iptv-org](https://github.com/iptv-org/iptv) (cerca de 400 no Brasil). Dá para filtrar digitando, e ↑ ↓ ou os botões de
canal do controle trocam de canal durante o vídeo. Não precisa de servidor: a TV busca a lista e toca os streams
(HLS) sozinha.

**Torrents.** Um app que pesquisa pelo qBittorrent e começa a tocar enquanto o download acontece, sem esperar o arquivo
inteiro. A TV mostra o progresso, e o vídeo começa quando o início e o fim do arquivo chegam. Antes de qualquer busca,
a lista mostra o que já está no qBittorrent.

**Servidor de mídia** ([`tools/media_server.py`](tools/media_server.py)). A ponte entre a TV e o qBittorrent, pela
[qbittorrent-api](https://qbittorrent-api.readthedocs.io/). Baixa em ordem só o vídeo escolhido, preferindo MP4 ou MKV e
ignorando arquivos de amostra, e envia o arquivo para a TV por partes (HTTP Range). Cada pedido exige um token.

**Instalação com Docker** ([`server/`](server/)). Um comando sobe o qBittorrent e o servidor de mídia, no próprio
computador ou numa VPS, gera senha e token e já configura o build da TV. Os torrents são apagados, com os arquivos, um
dia depois de terminarem.

**Desempenho em TVs mais simples.** A lista de canais desenha só as linhas visíveis. Durante o vídeo, a tela inicial por
baixo deixa de ser desenhada. A opção `lite` força o modo sem sombras nem animações em TVs com pouca memória.

## Como usar

1. Siga o [README](README.md) do projeto original para ativar o Modo Desenvolvedor na TV e instalar.
2. Para os Torrents, com o Docker aberto:
   ```
   server/deploy.sh                  # neste computador
   server/deploy.sh root@<IP da VPS> # ou numa VPS
   ```
   O script grava `media_server` e `media_token` no seu `config.properties`.
3. Gere e instale na TV:
   ```
   python3 webos/build.py && python3 webos/install.py <IP da TV>
   ```
4. Instale plugins de busca na Web UI do qBittorrent (o endereço aparece ao final do `deploy.sh`).

Novas opções no `config.properties`:

| Opção | O que faz |
|---|---|
| `iptv_country` | País dos canais (`br`, `us`, `pt`...). Vazio: o país da região da TV. |
| `media_server` | Endereço do servidor de mídia. Vazio: sem Torrents. |
| `media_token` | Token do servidor. Gravado pelo `deploy.sh`; mantenha privado. |
| `lite` | `true` força o modo leve, `false` nunca usa. Vazio: automático. |

Detalhes do servidor, portas e limpeza do disco: [`server/README.md`](server/README.md).

## Aviso

O BitTorrent compartilha o arquivo enquanto baixa, e o que é compartilhado fica ligado ao seu endereço de internet.
Use para conteúdo que você pode compartilhar, como filmes em domínio público ou Creative Commons (o
[Internet Archive](https://archive.org) tem milhares). Muitos provedores de VPS não permitem BitTorrent. Os canais vêm
da lista pública do iptv-org; alguns ficam fora do ar ou são bloqueados por região.

## Créditos

- [Free My TV](https://github.com/simbasjungles/free-my-tv), licença MIT: a base inteira deste fork.
- [iptv-org/iptv](https://github.com/iptv-org/iptv): a lista de canais.
- [qBittorrent](https://www.qbittorrent.org) e [qbittorrent-api](https://github.com/rmartin16/qbittorrent-api).
