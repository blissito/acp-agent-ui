/**
 * Un servidor MCP en 60 líneas, sin dependencias.
 *
 * La lección de la sesión 4: un MCP no es un servicio ni un puerto; es un
 * proceso que lee JSON-RPC por stdin y contesta por stdout. Quien lo lanza es
 * el Agente, dentro de su caja, y muere cuando la sesión termina.
 *
 * Prueba directa, sin la web de por medio:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/hello.ts
 */

type RpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };

const TOOLS = [
  {
    name: "saludar",
    description: "Saluda a alguien por su nombre. Sirve para comprobar que el MCP está vivo.",
    inputSchema: {
      type: "object",
      properties: { nombre: { type: "string", description: "A quién saludar" } },
      required: ["nombre"],
    },
  },
];

/** La respuesta viaja en una sola línea: el marco de MCP por stdio es JSON por renglón. */
function responder(id: RpcRequest["id"], result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function atender(req: RpcRequest) {
  switch (req.method) {
    case "initialize":
      return responder(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hello", version: "1.0.0" },
      });
    case "tools/list":
      return responder(req.id, { tools: TOOLS });
    case "tools/call": {
      const nombre = req.params?.arguments?.nombre ?? "mundo";
      return responder(req.id, {
        content: [{ type: "text", text: `Hola, ${nombre}. Te habla un MCP que vive en la caja.` }],
      });
    }
    default:
      // Las notificaciones (sin id) no se contestan: así lo pide JSON-RPC.
      if (req.id === undefined) return;
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no conozco ${req.method}` } }) + "\n",
      );
  }
}

let pendiente = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (trozo) => {
  pendiente += trozo;
  // Un `data` puede traer media línea o tres: se procesa por renglón completo.
  const lineas = pendiente.split("\n");
  pendiente = lineas.pop() ?? "";
  for (const linea of lineas) {
    if (!linea.trim()) continue;
    try {
      atender(JSON.parse(linea));
    } catch (e) {
      console.error("[hello] línea ilegible:", (e as Error).message);
    }
  }
});
