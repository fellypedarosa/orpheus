#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

type MissionStatus = "pending" | "running" | "completed" | "failed";

interface Mission {
  id: string;
  directive: string;
  persona?: string;
  status: MissionStatus;
  waitFor: string[];
  logFilePath: string;
  startTime?: Date;
  endTime?: Date;
  exitCode?: number;
  output?: string;
  error?: string;
  child?: ChildProcess;
  resources?: string[];
}

// Manage isolated "soldier" tasks of Gemini CLI
class SoldierCommander {
  private missions: Map<string, Mission> = new Map();
  private sessionsDir = path.join(process.cwd(), "sessoes");

  constructor() {
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }
  }

  public dispatch(directive: string, missionName?: string, persona?: string, waitFor: string[] = []): string {
    const id = missionName ? missionName.replace(/[^a-zA-Z0-9_-]/g, '_') : `missao-${Date.now()}`;
    const logFilePath = path.join(this.sessionsDir, `${id}.log`);
    
    this.missions.set(id, {
      id,
      directive,
      persona,
      status: "pending",
      waitFor,
      logFilePath,
      resources: []
    });

    // Tenta iniciar missões pendentes
    this.evaluateQueue();
    return id;
  }

  public async waitForMission(id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const mission = this.missions.get(id);
        if (!mission) return reject(new Error(`Missão não encontrada: ${id}`));
        if (mission.status === "completed") return resolve(mission.output || "Missão concluída sem output.");
        if (mission.status === "failed") return reject(new Error(`Missão falhou: ${mission.error || mission.output}`));
        setTimeout(check, 2000);
      };
      check();
    });
  }

  private evaluateQueue() {
    for (const [id, mission] of this.missions.entries()) {
      if (mission.status !== "pending") continue;

      let canStart = true;
      for (const depId of mission.waitFor) {
        const depMission = this.missions.get(depId);
        if (!depMission) {
          mission.status = "failed";
          mission.error = `Dependência não encontrada: ${depId}`;
          canStart = false;
          break;
        }
        if (depMission.status === "failed") {
          mission.status = "failed";
          mission.error = `Dependência falhou: ${depId}`;
          canStart = false;
          break;
        }
        if (depMission.status !== "completed") {
          canStart = false;
          break;
        }
      }

      if (canStart && mission.status === "pending") {
        this.startMission(mission);
      }
    }
  }

  private startMission(mission: Mission) {
    mission.status = "running";
    mission.startTime = new Date();

    let finalDirective = mission.directive;

    // 1. Contexto Compartilhado: Injetar Manifesto e Blueprints
    let sharedContext = "";

    const manifestPath = path.join(process.cwd(), ".orpheus_manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        sharedContext += fs.readFileSync(manifestPath, "utf-8") + "\n\n";
      } catch (e) {
        console.error("Erro ao ler manifesto:", e);
      }
    }

    const blueprintDir = path.join(process.cwd(), ".orpheus");
    if (fs.existsSync(blueprintDir)) {
      try {
        const files = fs.readdirSync(blueprintDir);
        for (const file of files) {
          if (file.endsWith(".md") || file.endsWith(".json") || file.endsWith(".yaml") || file.endsWith(".yml")) {
            const content = fs.readFileSync(path.join(blueprintDir, file), "utf-8");
            sharedContext += `[BLUEPRINT: ${file}]\n${content}\n\n`;
          }
        }
      } catch (e) {
         console.error("Erro ao ler blueprints:", e);
      }
    }

    if (sharedContext.trim().length > 0) {
      finalDirective = `[CONTEXTO COMPARTILHADO (Manifestos e Blueprints)]\n${sharedContext.trim()}\n\n[DIRETIVA DA MISSÃO]\n${finalDirective}`;
    }

    // 2. Auto-Linker (Notificação de Recursos)
    finalDirective = `[INSTRUÇÃO DE SISTEMA: AUTO-LINKER]\nSempre que você criar um novo arquivo essencial (como um novo componente, rota, script, css) que outros agentes/arquivos poderão precisar referenciar, você DEVE emitir exatamente a seguinte tag no seu texto de resposta (substitua pelo caminho do arquivo): [RESOURCE_CREATED: caminho/do/arquivo.ext]\n\n${finalDirective}`;

    // 3. Perfis de Especialização (Personas)
    if (mission.persona) {
      let personaContext = "";
      switch (mission.persona.toLowerCase()) {
        case "ui_expert":
          personaContext = "Você é um especialista em Frontend e UI/UX focado em estilização (ex: Tailwind), acessibilidade (a11y), design responsivo e micro-animações.";
          break;
        case "security_auditor":
          personaContext = "Você é um auditor de segurança e analista de código focado em encontrar e corrigir vulnerabilidades, vazamento de dados e falhas lógicas.";
          break;
        case "test_engineer":
          personaContext = "Você é um Engenheiro de Testes de Software obcecado por Qualidade, focado em TDD, cobertura de testes unitários e de integração abrangentes.";
          break;
        default:
          personaContext = `Atue rigorosamente sob este perfil/especialização: ${mission.persona}`;
      }
      finalDirective = `[PERFIL/PERSONA DA MISSÃO]\n${personaContext}\n\n${finalDirective}`;
    }

    const logStream = fs.createWriteStream(mission.logFilePath, { flags: 'w' });
    logStream.write(`=== INICIANDO MISSÃO: ${mission.id} ===\n`);
    if (mission.persona) logStream.write(`Persona Ativa: ${mission.persona}\n`);
    if (mission.waitFor.length > 0) logStream.write(`Dependências: ${mission.waitFor.join(', ')}\n`);
    logStream.write(`Diretiva Final (com contexto injetado):\n${finalDirective}\n\n`);
    logStream.write(`=== INICIANDO EXECUÇÃO DO SOLDADO ===\n\n`);

    const child = spawn("gemini", ["-p", finalDirective, "--yolo", "-m", "gemini-3-flash-preview"], {
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    mission.child = child;
    let fullOutput = "";

    child.stdout.on("data", (data) => {
      const text = data.toString("utf-8");
      const cleanText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      logStream.write(cleanText);
      fullOutput += cleanText;
    });

    child.stderr.on("data", (data) => {
      const text = data.toString("utf-8");
      const cleanText = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
      logStream.write(`[ERRO/WARN]: ${cleanText}`);
      fullOutput += `[ERRO/WARN]: ${cleanText}`;
    });

    child.on("close", (code) => {
      logStream.write(`\n=== MISSÃO CONCLUÍDA (Código: ${code}) ===\n`);
      logStream.end();
      
      mission.endTime = new Date();
      mission.exitCode = code ?? -1;
      mission.output = fullOutput;
      mission.child = undefined;

      // Extract generated resources
      const resourceRegex = /\[RESOURCE_CREATED:\s*(.+?)\]/g;
      let match;
      while ((match = resourceRegex.exec(fullOutput)) !== null) {
        if (match[1]) {
          mission.resources?.push(match[1].trim());
        }
      }
      
      if (code !== 0) {
        mission.status = "failed";
        mission.error = `Falha com código ${code}`;
      } else {
        mission.status = "completed";
      }

      this.evaluateQueue(); // Pode haver missões esperando essa terminar
    });

    child.on("error", (err) => {
      logStream.write(`\n=== FALHA AO INICIAR MISSÃO: ${err.message} ===\n`);
      logStream.end();
      
      mission.endTime = new Date();
      mission.status = "failed";
      mission.error = err.message;
      mission.child = undefined;

      this.evaluateQueue();
    });
  }

  public getMissionsStatus() {
    return Array.from(this.missions.values()).map(m => ({
      id: m.id,
      status: m.status,
      waitFor: m.waitFor,
      logFile: m.logFilePath,
      startTime: m.startTime,
      endTime: m.endTime,
      exitCode: m.exitCode,
      error: m.error,
      resources: m.resources
    }));
  }

  public getMissionLogs(id: string, tailLines: number = 100): string {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`Missão não encontrada: ${id}`);
    if (!fs.existsSync(mission.logFilePath)) return "Arquivo de log ainda não criado ou não encontrado.";
    
    const logs = fs.readFileSync(mission.logFilePath, "utf-8");
    const lines = logs.split("\n");
    if (lines.length <= tailLines) return logs;
    return `[... truncated ...]\n` + lines.slice(-tailLines).join("\n");
  }
}

const commander = new SoldierCommander();

const server = new Server({
  name: "gemini-soldier-commander-mcp",
  version: "2.0.0"
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "dispatch_soldier",
        description: "Envia uma missão para um 'soldado' (Gemini CLI em background). Suporta modo síncrono (aguarda) ou assíncrono (filas/dependências).",
        inputSchema: {
          type: "object",
          properties: {
            directive: {
              type: "string",
              description: "A instrução/tarefa clara e completa que o soldado deve executar."
            },
            mission_name: {
              type: "string",
              description: "(Opcional) Nome amigável para a missão."
            },
            persona: {
              type: "string",
              description: "(Opcional) Perfil de especialização ('ui_expert', 'security_auditor', 'test_engineer', ou customizado)."
            },
            wait_for: {
              type: "array",
              items: { type: "string" },
              description: "(Opcional) Lista de IDs de missões que devem ser concluídas antes desta começar."
            },
            mode: {
              type: "string",
              enum: ["sync", "async"],
              description: "(Opcional, default: 'sync') 'sync' bloqueia até terminar. 'async' retorna o ID imediatamente para você monitorar."
            }
          },
          required: ["directive"]
        }
      },
      {
        name: "get_missions_status",
        description: "Lista o status de todas as missões conhecidas (pending, running, completed, failed) e dependências.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      },
      {
        name: "get_mission_logs",
        description: "Lê o arquivo de log em tempo real de uma missão em andamento ou finalizada.",
        inputSchema: {
          type: "object",
          properties: {
            mission_id: { type: "string", description: "O ID da missão." },
            lines: { type: "number", description: "(Opcional) Número de linhas do fim do log (padrão 100)." }
          },
          required: ["mission_id"]
        }
      },
      {
        name: "dispatch_army",
        description: "Envia um array de missões independentes ou interdependentes em grid (paralelismo massivo). DICA: Se você (orquestrador) precisar definir regras globais para todos os soldados, crie uma pasta '.orpheus/' e salve arquivos '.md' ou '.json' nela; este servidor injetará esses blueprints automaticamente em todos os soldados.",
        inputSchema: {
          type: "object",
          properties: {
            missions: {
              type: "array",
              description: "Lista de missões a serem despachadas.",
              items: {
                type: "object",
                properties: {
                  directive: { type: "string" },
                  mission_name: { type: "string" },
                  persona: { type: "string" },
                  wait_for: { type: "array", items: { type: "string" } }
                },
                required: ["directive"]
              }
            }
          },
          required: ["missions"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "dispatch_soldier") {
    const args = request.params.arguments as any;
    const { directive, mission_name, persona, wait_for = [], mode = "sync" } = args;

    if (typeof directive !== "string") {
       throw new McpError(ErrorCode.InvalidParams, "A diretiva (directive) deve ser uma string.");
    }

    try {
      const missionId = commander.dispatch(directive, mission_name, persona, wait_for);
      
      if (mode === "async") {
        return {
          content: [{ type: "text", text: `Missão registrada com sucesso!\nID: ${missionId}\nStatus: PENDING/RUNNING.\nUse 'get_missions_status' para monitorar.` }]
        };
      }

      // Sync mode
      const finalReport = await commander.waitForMission(missionId);
      return {
        content: [{ type: "text", text: `Missão ${missionId} concluída.\nSaída:\n${finalReport}` }]
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Erro ao despachar soldado: ${e.message}` }],
        isError: true
      };
    }
  }

  if (request.params.name === "dispatch_army") {
    const args = request.params.arguments as any;
    const missions = args.missions;

    if (!Array.isArray(missions)) {
       throw new McpError(ErrorCode.InvalidParams, "O parâmetro 'missions' deve ser um array.");
    }

    try {
      const dispatchedIds = [];
      for (const m of missions) {
        if (typeof m.directive !== "string") continue;
        const missionId = commander.dispatch(m.directive, m.mission_name, m.persona, m.wait_for || []);
        dispatchedIds.push(missionId);
      }
      
      return {
        content: [{ type: "text", text: `Exército despachado com sucesso!\nMissões criadas:\n${dispatchedIds.join("\n")}\nUse 'get_missions_status' para monitorar o andamento da grid.` }]
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: `Erro ao despachar exército: ${e.message}` }],
        isError: true
      };
    }
  }

  if (request.params.name === "get_missions_status") {
    const statuses = commander.getMissionsStatus();
    return {
      content: [{ type: "text", text: JSON.stringify(statuses, null, 2) }]
    };
  }

  if (request.params.name === "get_mission_logs") {
    const args = request.params.arguments as any;
    try {
      const logs = commander.getMissionLogs(args.mission_id, args.lines);
      return {
        content: [{ type: "text", text: logs }]
      };
    } catch (e: any) {
      return {
        content: [{ type: "text", text: e.message }],
        isError: true
      };
    }
  }
  
  throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini CLI Soldier Commander MCP Server running on stdio");
}

main().catch(console.error);