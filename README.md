# Orpheus MCP Server (v2.0.0)

Um servidor do Model Context Protocol (MCP) desenvolvido em TypeScript/Node.js que transforma a CLI do Gemini em "soldados" executores independentes. Este servidor permite que um orquestrador central (como o Antigravity) delegue tarefas, gerencie filas de dependências e monitore a execução de instâncias em background do Gemini CLI.

## Como Funciona

O Orpheus adota uma abordagem de **"Soldados Descartáveis e Rastreáveis"**:
1. O Antigravity envia uma diretiva via chamada de ferramenta do MCP.
2. O servidor instancia um novo processo isolado do Gemini CLI executando a diretiva em modo silencioso e sem confirmações (`--yolo`).
3. Uma pasta `sessoes/` é criada no diretório atual de trabalho.
4. Um arquivo de log (ex: `sessoes/missao-12345.log`) é gerado, capturando todo o fluxo de pensamento, execução de ferramentas e saída do Gemini CLI em tempo real.
5. Dependendo do modo escolhido (`sync` ou `async`), o orquestrador aguarda a conclusão ou continua livre para monitorar e despachar novos soldados.

### Novidades na Versão 2.0 (Fase 2)

*   **Contexto Compartilhado (Manifesto e Blueprints):** Se existir um arquivo `.orpheus_manifest.json` no diretório raiz, ou arquivos de documentação (`.md`, `.yaml`, `.json`) dentro da pasta `.orpheus/`, eles serão automaticamente injetados como contexto de restrição global ("Blueprints") na diretiva de todos os soldados despachados.
*   **Auto-Linker (Notificação de Recursos):** Soldados são instruídos a notificar o orquestrador sobre arquivos gerados durante a missão. O servidor MCP extrai essas tags e disponibiliza a lista de arquivos criados no campo `resources` ao consultar o status das missões.
*   **Perfis de Especialização (Personas):** Suporte nativo para instruir o soldado a assumir papéis como `ui_expert`, `security_auditor`, `test_engineer` ou qualquer outro contexto customizado antes de iniciar a missão.
*   **Grafo de Dependências e Filas:** Missões podem ser despachadas assincronamente informando quais outras missões devem terminar primeiro (parâmetro `wait_for`).
*   **Monitoramento Ativo:** Novas ferramentas permitem que o orquestrador verifique o status da fila de missões e leia logs em tempo real sem bloquear sua própria thread.
*   **Execução em Grid (Army Dispatch):** Despache um "exército" de missões através da nova ferramenta `dispatch_army`, permitindo maximizar a velocidade de desenvolvimento com paralelismo massivo.

## Instalação e Uso Global

O projeto já está configurado para ser executado como um binário global em seu sistema.

Para recompilar e linkar o projeto manualmente (caso faça alterações no código):
```bash
npm install
npm run build
npm link
```

Isto disponibiliza o comando `orpheus-mcp` globalmente no seu sistema operacional.

## Configuração no Antigravity

Configure o cliente MCP do Antigravity para executar o comando `orpheus-mcp`:

```json
{
  "mcpServers": {
    "gemini-soldier-commander": {
      "command": "orpheus-mcp",
      "args": []
    }
  }
}
```

O Antigravity iniciará o `orpheus-mcp` sempre que precisar delegar tarefas. Os arquivos `.log` dos soldados serão criados na pasta `sessoes/` do seu projeto atual.

## Ferramentas (Tools) Expostas

O servidor expõe as seguintes ferramentas via protocolo MCP:

### 1. `dispatch_soldier`
Envia uma missão isolada para um 'soldado' (Gemini CLI em background). Suporta modo síncrono ou assíncrono (com filas/dependências).
*   **Parâmetros**: 
    *   `directive` (string): A instrução/tarefa clara e completa que o soldado deve executar.
    *   `mission_name` (string, opcional): Nome amigável para a missão (usado no nome do arquivo de log).
    *   `persona` (string, opcional): Aplica um perfil de especialização. Ex: `ui_expert`, `security_auditor`, `test_engineer`, ou customizado.
    *   `wait_for` (array de strings, opcional): Lista de IDs de missões que devem ser concluídas com sucesso antes desta começar.
    *   `mode` (string, opcional): `sync` (padrão, bloqueia até terminar) ou `async` (retorna o ID da missão imediatamente para o orquestrador continuar).

### 2. `get_missions_status`
Lista o status de todas as missões conhecidas e suas dependências.
*   **Retorna**: JSON com a lista de missões, mostrando o status (`pending`, `running`, `completed`, `failed`), horários de início/fim e códigos de erro.

### 3. `get_mission_logs`
Lê o arquivo de log em tempo real de uma missão em andamento ou finalizada. Excelente para o orquestrador monitorar soldados em missões assíncronas.
*   **Parâmetros**:
    *   `mission_id` (string): O ID da missão (retornado por `dispatch_soldier` no modo async).
    *   `lines` (number, opcional): Número de linhas a ler do fim do arquivo (padrão: 100).

### 4. `dispatch_army`
Envia um "exército" inteiro de missões de uma só vez (execução em grid / paralelismo massivo).
*   **Parâmetros**:
    *   `missions` (array de objetos): Uma lista onde cada objeto pode conter `directive`, `mission_name`, `persona` e `wait_for`. Retorna um array com os IDs de todas as missões criadas para monitoramento.

## Aviso de Segurança ⚠️

Este servidor inicia instâncias do Gemini CLI utilizando a flag `--yolo`. Isso significa que os "soldados" executarão todos os comandos (incluindo edições de arquivos e scripts de shell) **sem pedir confirmação humana**. 

Ao utilizar o Orpheus MCP, certifique-se de:
1. Confiar no orquestrador (Antigravity) que está enviando as diretivas.
2. Não executar o servidor como usuário `root`.
3. Manter as diretivas delimitadas ao contexto do projeto atual.

## Monitoramento Manual (Humano)

Para acompanhar o que um agente está fazendo enquanto a missão ocorre em background:
1. Abra a pasta `sessoes/` no seu editor (ex: VS Code).
2. Clique no arquivo `.log` correspondente à missão para ver a execução em tempo real.
3. Alternativamente, no terminal: `tail -f sessoes/missao-*.log`
