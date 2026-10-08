import express from "express";
import { z } from "zod";
import { XMLParser } from "fast-xml-parser";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const env = (k: string, required = true) => {
  const v = process.env[k];
  if (required && !v) throw new Error(`Variável de ambiente ausente: ${k}`);
  return v ?? "";
};
const trim = (u: string) => u.replace(/\/+$/, "");
const AUTH = trim(env("SFMC_AUTH_URL"));
const REST = trim(env("SFMC_REST_URL"));
const SOAP = trim(env("SFMC_SOAP_URL"));
const CLIENT_ID = env("SFMC_CLIENT_ID");
const CLIENT_SECRET = env("SFMC_CLIENT_SECRET");
const ACCOUNT_ID = env("SFMC_ACCOUNT_ID", false);
const PATH_TOKEN = env("MCP_PATH_TOKEN");

// ---------- Token OAuth com cache ----------
let cached: { token: string; exp: number } | null = null;
async function getToken(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.token;
  const body: Record<string, string> = { grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
  if (ACCOUNT_ID) body.account_id = ACCOUNT_ID;
  const r = await fetch(`${AUTH}/v2/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Falha no token SFMC: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return cached.token;
}

async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${REST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`SFMC REST ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

// ---------- Servidor MCP ----------
function buildServer() {
  const server = new McpServer({ name: "sfmc-stays", version: "0.1.0" });

  server.registerTool(
    "consultar_data_extension",
    {
      description: "Lê linhas de uma Data Extension do Marketing Cloud pela External Key. Aceita filtro OData simples (ex.: \"Email eq 'x@y.com'\").",
      inputSchema: {
        externalKey: z.string().describe("External Key da Data Extension"),
        filtro: z.string().optional().describe("Filtro no formato do SFMC, ex.: \"Status eq 'Ativo'\""),
        pagina: z.number().int().min(1).default(1),
        tamanhoPagina: z.number().int().min(1).max(2500).default(50),
      },
    },
    async ({ externalKey, filtro, pagina, tamanhoPagina }) => {
      const q = new URLSearchParams({ $page: String(pagina), $pageSize: String(tamanhoPagina) });
      if (filtro) q.set("$filter", filtro);
      const j = await rest(`/data/v1/customobjectdata/key/${encodeURIComponent(externalKey)}/rowset?${q}`);
      return ok({ total: j.count, pagina: j.page, linhas: (j.items ?? []).map((i: any) => ({ ...i.keys, ...i.values })) });
    }
  );

  server.registerTool(
    "listar_journeys",
    {
      description: "Lista Journeys do Marketing Cloud com status, versão e datas. Pode filtrar por nome e status.",
      inputSchema: {
        busca: z.string().optional().describe("Trecho do nome ou descrição"),
        status: z.enum(["Draft", "Published", "ScheduledToPublish", "Stopped", "Unpublished", "Deleted"]).optional(),
        pagina: z.number().int().min(1).default(1),
        tamanhoPagina: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ busca, status, pagina, tamanhoPagina }) => {
      const q = new URLSearchParams({ $page: String(pagina), $pageSize: String(tamanhoPagina), mostRecentVersionOnly: "true" });
      if (busca) q.set("nameOrDescription", busca);
      if (status) q.set("status", status);
      const j = await rest(`/interaction/v1/interactions?${q}`);
      return ok({
        total: j.count,
        journeys: (j.items ?? []).map((i: any) => ({
          id: i.id, key: i.key, nome: i.name, versao: i.version, status: i.status,
          criado: i.createdDate, modificado: i.modifiedDate, entradaEventKey: i.defaults?.email?.[0] ?? undefined,
        })),
      });
    }
  );

  server.registerTool(
    "metricas_envios",
    {
      description: "Métricas de envios de e-mail (enviados, entregues, aberturas e cliques únicos, bounces, descadastros) a partir de uma data.",
      inputSchema: {
        desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Data inicial AAAA-MM-DD"),
        nomeEmail: z.string().optional().describe("Filtra pelo nome do e-mail (contém)"),
      },
    },
    async ({ desde, nomeEmail }) => {
      const props = ["ID", "EmailName", "Subject", "SendDate", "Status", "NumberSent", "NumberDelivered", "UniqueOpens", "UniqueClicks", "HardBounces", "SoftBounces", "Unsubscribes"];
      const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <s:Header>
    <a:Action s:mustUnderstand="1">Retrieve</a:Action>
    <a:To s:mustUnderstand="1">${SOAP}/Service.asmx</a:To>
    <fueloauth xmlns="http://exacttarget.com">${await getToken()}</fueloauth>
  </s:Header>
  <s:Body>
    <RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">
      <RetrieveRequest>
        <ObjectType>Send</ObjectType>
        ${props.map((p) => `<Properties>${p}</Properties>`).join("")}
        <Filter xsi:type="SimpleFilterPart">
          <Property>SendDate</Property><SimpleOperator>greaterThan</SimpleOperator><DateValue>${xml(desde)}T00:00:00</DateValue>
        </Filter>
      </RetrieveRequest>
    </RetrieveRequestMsg>
  </s:Body>
</s:Envelope>`;
      const r = await fetch(`${SOAP}/Service.asmx`, { method: "POST", headers: { "Content-Type": "text/xml", SOAPAction: "Retrieve" }, body: envelope });
      const text = await r.text();
      if (!r.ok) throw new Error(`SFMC SOAP ${r.status}: ${text.slice(0, 500)}`);
      const parsed = new XMLParser({ removeNSPrefix: true }).parse(text);
      const resp = parsed?.Envelope?.Body?.RetrieveResponseMsg;
      let envios = asArray<any>(resp?.Results).map((s) => {
        const n = (k: string) => Number(s[k] ?? 0);
        const entregues = n("NumberDelivered") || n("NumberSent");
        return {
          id: s.ID, email: s.EmailName, assunto: s.Subject, data: s.SendDate, status: s.Status,
          enviados: n("NumberSent"), entregues, aberturasUnicas: n("UniqueOpens"), cliquesUnicos: n("UniqueClicks"),
          taxaAbertura: entregues ? +(n("UniqueOpens") / entregues * 100).toFixed(2) : null,
          taxaClique: entregues ? +(n("UniqueClicks") / entregues * 100).toFixed(2) : null,
          hardBounces: n("HardBounces"), softBounces: n("SoftBounces"), descadastros: n("Unsubscribes"),
        };
      });
      if (nomeEmail) envios = envios.filter((e) => String(e.email ?? "").toLowerCase().includes(nomeEmail.toLowerCase()));
      return ok({ statusSfmc: resp?.OverallStatus, maisResultados: resp?.OverallStatus === "MoreDataAvailable", total: envios.length, envios });
    }
  );

  server.registerTool(
    "disparar_entrada_journey",
    {
      description: "AÇÃO DE ESCRITA: coloca um contato em um Journey via API Event. Confirme com o usuário antes de usar.",
      inputSchema: {
        eventDefinitionKey: z.string().describe("Event Definition Key da entrada do Journey (API Event)"),
        contactKey: z.string().describe("Contact Key / Subscriber Key do contato"),
        dados: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}).describe("Campos exigidos pela Data Extension de entrada"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ eventDefinitionKey, contactKey, dados }) => {
      const j = await rest(`/interaction/v1/events`, {
        method: "POST",
        body: JSON.stringify({ ContactKey: contactKey, EventDefinitionKey: eventDefinitionKey, Data: dados }),
      });
      return ok({ disparado: true, eventInstanceId: j.eventInstanceId });
    }
  );

  return server;
}

// ---------- HTTP (Streamable HTTP, stateless) ----------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post(`/mcp/${PATH_TOKEN}`, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
  }
});
app.all(`/mcp/${PATH_TOKEN}`, (_req, res) => res.status(405).set("Allow", "POST").end());

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => console.log(`SFMC MCP ouvindo na porta ${port}`));
