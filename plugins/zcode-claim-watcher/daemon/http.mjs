// daemon HTTP 传输层（零依赖，node:http）：Streamable HTTP MCP + 诊断端点。
//  - POST /mcp：JSON-RPC 2.0（stateless，无会话头）。客户端 Accept 含 text/event-stream
//    则回单消息 SSE 帧（event: message + data: JSON + 空行），否则 application/json——兼容两类客户端。
//    initialize 回显 protocolVersion（缺省 2024-11-05）；无 id 通知回 202；GET /mcp 405；DELETE /mcp 204。
//  - GET /health：{ok,pid,version,uptime,roundCount}（诊断/ensure 幂等探测）
//  - POST /shutdown：优雅退出
//  - 端口绑定即单实例锁：EADDRINUSE 时探测 /health，已有健康实例 → {healthyExisting:true}，
//    serve 层按此 exit 0；被其他程序占用 → exit 1。
// 端口：缺省 47823 绑定 127.0.0.1；ZCODE_DAEMON_PORT 仅用于测试隔离（插件清单里的 URL 是静态
// 字面量，正常部署固定 47823）。
import { createServer } from "node:http";

export const DAEMON_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47823;

export function daemonPort() {
  const n = Number(process.env.ZCODE_DAEMON_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export function mcpUrl(port = daemonPort()) {
  return `http://${DAEMON_HOST}:${port}/mcp`;
}
export function healthUrl(port = daemonPort()) {
  return `http://${DAEMON_HOST}:${port}/health`;
}
export function shutdownUrl(port = daemonPort()) {
  return `http://${DAEMON_HOST}:${port}/shutdown`;
}

// 探测 /health：可达且 body.ok === true 才视为健康（区分"我们的 daemon"与"端口被其他程序占用"）
export async function probeHealth(port = daemonPort(), timeoutMs = 800) {
  try {
    const res = await fetch(healthUrl(port), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    return JSON.parse(await res.text()).ok === true;
  } catch {
    return false;
  }
}

const MAX_BODY = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求体过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// MCP Streamable HTTP 响应：Accept 含 text/event-stream → 单消息 SSE 帧；否则 application/json
function sendRpc(res, req, payload) {
  if (req.headers.accept?.includes("text/event-stream")) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function handleMcpPost({ req, res, ctx }) {
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (e) {
    if (e?.statusCode) {
      res.writeHead(e.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    if (msg?.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    sendRpc(res, req, { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "Invalid Request" } });
    return;
  }

  // 通知（无 id）：无需响应体
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  const reply = (result) => sendRpc(res, req, { jsonrpc: "2.0", id: msg.id, result });
  const replyError = (code, message) => sendRpc(res, req, { jsonrpc: "2.0", id: msg.id, error: { code, message } });

  try {
    if (msg.method === "initialize") {
      reply({ protocolVersion: msg.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: ctx.serverInfo() });
    } else if (msg.method === "ping") {
      reply({});
    } else if (msg.method === "tools/list") {
      reply({ tools: ctx.tools() });
    } else if (msg.method === "tools/call") {
      reply(await ctx.handleToolCall(msg.params?.name, msg.params?.arguments));
    } else {
      replyError(-32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    replyError(-32000, String(e?.message ?? e));
  }
}

// 启动 HTTP 服务；resolve(server) 或 reject({code:"EADDRINUSE", healthyExisting})
export function startDaemonHttp({ port = daemonPort(), host = DAEMON_HOST, tools, handleToolCall, serverInfo, health, onShutdown, logger = () => {} } = {}) {
  const ctx = { tools, handleToolCall, serverInfo };
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    try {
      if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health()));
        return;
      }
      if (path === "/shutdown" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        logger("收到 /shutdown，优雅退出");
        setTimeout(() => onShutdown?.(), 50).unref?.();
        return;
      }
      if (path === "/mcp") {
        if (req.method === "POST") return await handleMcpPost({ req, res, ctx });
        if (req.method === "DELETE") {
          res.writeHead(204).end();
          return;
        }
        res.writeHead(405, { "Content-Type": "application/json", Allow: "POST, DELETE" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method Not Allowed（MCP 经 HTTP 传输仅接受 POST /mcp）" } }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    } catch (e) {
      logger(`HTTP 处理异常: ${e?.message ?? e}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", async (err) => {
      if (err?.code === "EADDRINUSE") {
        // 端口绑定即单实例锁：已有健康实例 → 视为拉起成功；否则被其他程序占用
        const healthyExisting = await probeHealth(port, 1500);
        reject(Object.assign(new Error(`端口 ${port} 已被占用`), { code: "EADDRINUSE", healthyExisting }));
        return;
      }
      reject(err);
    });
    server.listen(port, host, () => resolve(server));
  });
}
