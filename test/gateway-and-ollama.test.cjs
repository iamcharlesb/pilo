const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const fw = require("../dist/index.js");
const gatewaySubpath = require("../dist/gateway/index.js");

/**
 * Starts a local mock Ollama HTTP server implementing:
 * - GET  /api/tags
 * - POST /api/chat (plain chat, native tool calling, structured output)
 * - POST /api/generate (text completion)
 */
async function startMockOllamaServer() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const body = rawBody ? JSON.parse(rawBody) : {};
    requests.push({ method: req.method, url: req.url, body });

    res.setHeader("Content-Type", "application/json");

    if (req.method === "GET" && req.url === "/api/tags") {
      res.end(
        JSON.stringify({
          models: [
            { name: "llama3.2:latest", size: 2048 },
            { name: "qwen2.5-coder:latest", size: 4096 }
          ]
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/generate") {
      res.end(
        JSON.stringify({
          response: `ollama-completion:${body.prompt}`,
          done: true,
          done_reason: "stop",
          prompt_eval_count: 10,
          eval_count: 6
        })
      );
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      // Structured output via JSON schema in `format`
      if (body.format && typeof body.format === "object") {
        res.end(
          JSON.stringify({
            message: {
              role: "assistant",
              content: JSON.stringify({ summary: "structured-ok", confidence: 0.95 })
            },
            done: true,
            prompt_eval_count: 14,
            eval_count: 9
          })
        );
        return;
      }

      // Native tool calling: if tools were provided and no tool result yet, emit a tool call
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === "tool");
      if (Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult) {
        const firstTool = body.tools[0].function.name;
        res.end(
          JSON.stringify({
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: firstTool,
                    arguments: { input: "6 * 7" }
                  }
                }
              ]
            },
            done: true,
            prompt_eval_count: 20,
            eval_count: 12
          })
        );
        return;
      }

      if (hasToolResult) {
        const toolMsg = body.messages.find((m) => m.role === "tool");
        res.end(
          JSON.stringify({
            message: {
              role: "assistant",
              content: `Calculated result is ${toolMsg.content}`
            },
            done: true,
            prompt_eval_count: 25,
            eval_count: 8
          })
        );
        return;
      }

      const lastUser = Array.isArray(body.messages)
        ? body.messages[body.messages.length - 1]?.content ?? ""
        : "";
      res.end(
        JSON.stringify({
          message: {
            role: "assistant",
            content: `ollama-chat(${body.model}): ${lastUser}`
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 12,
          eval_count: 7
        })
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

test("ChatOllama supports generation, native tool calling, structured output, token usage, and model discovery", async () => {
  const mockOllama = await startMockOllamaServer();
  try {
    const chat = new fw.ChatOllama({
      model: "llama3.2",
      baseUrl: mockOllama.baseUrl
    });

    assert.equal(await chat.isAvailable(), true);
    const models = await chat.listModels();
    assert.equal(models.length, 2);
    assert.equal(models[0].name, "llama3.2:latest");

    const gen = await chat.generate([[{ role: "human", content: "hello" }]]);
    assert.equal(gen.generations[0][0].text, "ollama-chat(llama3.2): hello");
    assert.deepEqual(gen.llmOutput.usage, {
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19
    });

    const calcTool = new fw.CalculatorTool();
    const firstTurn = await chat.callWithTools(
      [{ role: "human", content: "What is 6 * 7?" }],
      [calcTool.toSchema()]
    );
    assert.equal(firstTurn.toolCalls.length, 1);
    assert.equal(firstTurn.toolCalls[0].name, "calculator");
    assert.deepEqual(JSON.parse(firstTurn.toolCalls[0].arguments), { input: "6 * 7" });

    const secondTurn = await chat.callWithTools(
      [
        { role: "human", content: "What is 6 * 7?" },
        firstTurn,
        { role: "tool", name: "calculator", toolCallId: firstTurn.toolCalls[0].id, content: "42" }
      ],
      [calcTool.toSchema()]
    );
    assert.equal(secondTurn.content, "Calculated result is 42");

    const structured = await chat.generateStructured(
      [{ role: "human", content: "Summarize" }],
      {
        name: "summary_schema",
        schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            confidence: { type: "number" }
          },
          required: ["summary", "confidence"]
        }
      }
    );
    assert.deepEqual(structured, { summary: "structured-ok", confidence: 0.95 });
  } finally {
    await mockOllama.close();
  }
});

test("OllamaLLM supports text completions, usage tracking, and model discovery", async () => {
  const mockOllama = await startMockOllamaServer();
  try {
    const llm = new fw.OllamaLLM({
      model: "llama3.2",
      baseUrl: mockOllama.baseUrl,
      system: "Be concise."
    });

    assert.equal(await llm.isAvailable(), true);
    const result = await llm.generate(["ping"]);
    assert.equal(result.generations[0][0].text, "ollama-completion:ping");
    assert.deepEqual(result.llmOutput.usage, {
      prompt_tokens: 10,
      completion_tokens: 6,
      total_tokens: 16
    });
  } finally {
    await mockOllama.close();
  }
});

test("createAgent with provider ollama runs end-to-end tool calling loop", async () => {
  const mockOllama = await startMockOllamaServer();
  try {
    const agent = fw.createAgent({
      provider: "ollama",
      model: "llama3.2",
      baseUrl: mockOllama.baseUrl,
      tools: [new fw.CalculatorTool()]
    });

    const answer = await agent.ask("Compute 6 * 7");
    assert.equal(answer.text, "Calculated result is 42");
  } finally {
    await mockOllama.close();
  }
});

test("AgentGateway enforces zero-trust auth, RBAC-filtered MCP federation, guardrails, and rate limits", async () => {
  const jwtSecret = "unit-test-hs256-signing-material";
  const analystKey = "unit-test-analyst-key-value";

  const auth = new fw.CompositeAuthenticator([
    new fw.HS256Authenticator({ secret: jwtSecret, issuer: "fw-test" }),
    new fw.ApiKeyAuthenticator([{ id: "analyst-1", key: analystKey, roles: ["analyst"] }])
  ]);

  const rbac = new fw.RBACAuthorizer({
    defaultAllow: false,
    roles: [
      {
        name: "analyst",
        permissions: [{ resourceType: "mcp_tool", action: "call", resourceId: "math__calculator" }]
      },
      {
        name: "admin",
        permissions: [{ resourceType: "*", action: "*", resourceId: "*" }]
      }
    ]
  });

  const guardrail = fw.createPatternGuardrail({
    id: "block-forbidden-token",
    description: "Blocked forbidden phrase.",
    patterns: [/DROP\s+TABLE/i]
  });

  const mathServer = new fw.MCPServer({
    tools: [new fw.CalculatorTool()]
  });
  const opsServer = new fw.MCPServer({
    tools: [
      new fw.DynamicTool({
        name: "deploy",
        description: "Deploy a release.",
        func: async (input) => ({ output: `deployed:${input}` })
      })
    ],
    resources: [
      {
        uri: "status://cluster",
        name: "cluster-status",
        read: () => ({ uri: "status://cluster", text: "healthy" })
      }
    ]
  });

  const gateway = new fw.AgentGateway({
    name: "test-gateway",
    authenticator: auth,
    authorizer: rbac,
    guardrails: [guardrail],
    rateLimit: { maxRequests: 3, windowMs: 60_000, keyBy: "actor" }
  });

  gateway.registerMCPBackend({ id: "math", namespace: "math", server: mathServer });
  gateway.registerMCPBackend({ id: "ops", namespace: "ops", server: opsServer });

  // Unauthenticated request rejected
  const unauthResp = await gateway.handleMCPRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list"
  });
  assert.ok("error" in unauthResp);
  assert.equal(unauthResp.error.code, -32001);

  // Analyst only sees math__calculator
  const analystHeaders = { "x-api-key": analystKey };
  const analystList = await gateway.handleMCPRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    analystHeaders
  );
  assert.ok("result" in analystList);
  assert.deepEqual(
    analystList.result.tools.map((t) => t.name),
    ["math__calculator"]
  );

  // Analyst can call math__calculator
  const calcCall = await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "math__calculator", arguments: { input: "10 + 5" } }
    },
    analystHeaders
  );
  assert.ok("result" in calcCall);
  assert.equal(calcCall.result.content[0].text, "15");

  // Analyst is denied ops__deploy
  const deniedCall = await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ops__deploy", arguments: { input: "prod" } }
    },
    analystHeaders
  );
  assert.ok("error" in deniedCall);
  assert.equal(deniedCall.error.code, -32003);

  // Guardrail blocks malicious input even for admin
  const adminToken = fw.HS256Authenticator.sign(
    { sub: "admin-1", iss: "fw-test", roles: ["admin"] },
    jwtSecret
  );
  const adminHeaders = { authorization: `Bearer ${adminToken}` };

  const blockedCall = await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ops__deploy", arguments: { input: "DROP TABLE users" } }
    },
    adminHeaders
  );
  assert.ok("error" in blockedCall);
  assert.equal(blockedCall.error.code, -32003);

  // Admin can read federated namespaced resource
  const resList = await gateway.handleMCPRequest(
    { jsonrpc: "2.0", id: 6, method: "resources/list" },
    adminHeaders
  );
  assert.ok("result" in resList);
  assert.equal(resList.result.resources[0].uri, "ops://cluster");

  const resRead = await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "ops://cluster" }
    },
    adminHeaders
  );
  assert.ok("result" in resRead);
  assert.equal(resRead.result.contents[0].text, "healthy");

  // Rate limit triggers on 4th governed call for analyst
  await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "math__calculator", arguments: { input: "1 + 1" } }
    },
    analystHeaders
  );
  const rateLimited = await gateway.handleMCPRequest(
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "math__calculator", arguments: { input: "2 + 2" } }
    },
    analystHeaders
  );
  assert.ok("error" in rateLimited);
  assert.equal(rateLimited.error.code, -32029);
});

test("AgentGatewayServer exposes HTTP MCP, A2A Ollama agent, LLM failover to Ollama, and metrics", async () => {
  const mockOllama = await startMockOllamaServer();

  // Failing primary chat model to verify automatic failover to local Ollama
  class FailingChatModel extends fw.BaseChatModel {
    constructor() {
      super({});
      this.modelName = "primary-cloud-model";
    }
    _modelType() {
      return "failing-mock";
    }
    async generate() {
      throw new Error("Simulated upstream cloud outage");
    }
  }

  const gateway = new fw.AgentGateway({
    name: "fireworks-gateway-e2e",
    allowAnonymous: true,
    budgetManager: new fw.BudgetManager({ limits: [{ name: "total_tokens", max: 1000 }] })
  });

  gateway.registerMCPBackend({
    id: "math",
    namespace: "math",
    server: new fw.MCPServer({ tools: [new fw.CalculatorTool()] })
  });

  gateway.registerOllamaLLM({
    id: "ollama-local",
    model: "llama3.2",
    baseUrl: mockOllama.baseUrl,
    aliases: ["local"]
  });

  gateway.registerLLMBackend({
    id: "cloud-primary",
    provider: "mock-cloud",
    model: "primary-cloud-model",
    fallbackTargets: ["ollama-local"],
    chatModel: new FailingChatModel()
  });

  await gateway.registerOllamaAgent({
    id: "ollama-math-agent",
    name: "Ollama Math Agent",
    description: "Local Ollama agent powered by gateway-federated MCP tools.",
    model: "llama3.2",
    baseUrl: mockOllama.baseUrl,
    useGatewayMCP: true
  });

  const server = new fw.AgentGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
  const { url } = await server.start();

  try {
    // 1. Health & Well-Known Agent Card
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.ok, true);

    const card = await (await fetch(`${url}/.well-known/agent.json`)).json();
    assert.equal(card.id, "fireworks-gateway-e2e");
    assert.equal(card.capabilities.mcp, true);
    assert.equal(card.skills.length, 1);

    // 2. HTTP MCP transport works against /mcp
    const remoteClient = new fw.MCPClient({
      transport: new fw.HttpMCPTransport({ url: `${url}/mcp` })
    });
    await remoteClient.initialize();
    const remoteTools = await remoteClient.listTools();
    assert.deepEqual(remoteTools.map((t) => t.name), ["math__calculator"]);

    // 3. A2A Task routed to Ollama Agent using gateway-federated MCP tool
    const taskResp = await (
      await fetch(`${url}/a2a/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId: "ollama-math-agent",
          input: "Calculate 6 * 7"
        })
      })
    ).json();
    assert.equal(taskResp.task.state, "completed");
    assert.equal(taskResp.task.output, "Calculated result is 42");

    const fetchedTask = await (await fetch(`${url}/a2a/tasks/${taskResp.task.id}`)).json();
    assert.equal(fetchedTask.task.id, taskResp.task.id);
    assert.equal(fetchedTask.task.state, "completed");

    // 4. Unified LLM /v1/chat/completions with automatic failover from cloud-primary -> ollama-local
    const chatResp = await (
      await fetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "cloud-primary",
          messages: [{ role: "user", content: "hello failover" }]
        })
      })
    ).json();
    assert.equal(chatResp.gateway.target, "ollama-local");
    assert.equal(chatResp.gateway.provider, "ollama");
    assert.equal(chatResp.gateway.fallbackUsed, true);
    assert.equal(chatResp.choices[0].message.content, "ollama-chat(llama3.2): hello failover");
    assert.equal(chatResp.usage.total_tokens, 19);

    // 5. Unified LLM /v1/completions routed to OllamaLLM via alias
    const cmplResp = await (
      await fetch(`${url}/v1/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local",
          prompt: "hello completion"
        })
      })
    ).json();
    assert.equal(cmplResp.choices[0].text, "ollama-completion:hello completion");

    // 6. Metrics endpoint reports protocol counts and token usage
    const metrics = await (await fetch(`${url}/metrics`)).json();
    assert.ok(metrics.totals.requests >= 5);
    assert.ok(metrics.totals.totalTokens >= 35);
    assert.ok(metrics.byProtocol.mcp.requests >= 2);
    assert.ok(metrics.byProtocol.a2a.requests >= 1);
    assert.ok(metrics.byProtocol.llm.requests >= 2);
  } finally {
    await server.stop();
    await mockOllama.close();
  }
});

test("createGatewayFromConfig wires declarative Ollama gateway and subpath export works", async () => {
  assert.equal(typeof gatewaySubpath.AgentGateway, "function");
  assert.equal(typeof gatewaySubpath.AgentGatewayServer, "function");

  const mockOllama = await startMockOllamaServer();
  try {
    const gateway = fw.createGatewayFromConfig(
      {
        name: "declarative-gw",
        auth: {
          apiKeys: [{ id: "svc", keyEnv: "TEST_GW_KEY", roles: ["runner"] }]
        },
        rbac: {
          defaultAllow: false,
          roles: [
            {
              name: "runner",
              permissions: [{ resourceType: "llm_model", action: "invoke", resourceId: "ollama-default" }]
            }
          ]
        },
        llmBackends: [
          {
            id: "ollama-default",
            provider: "ollama",
            model: "llama3.2",
            baseUrl: mockOllama.baseUrl
          }
        ]
      },
      { TEST_GW_KEY: "declarative-test-key" }
    );

    const models = await gateway.listModels({ "x-api-key": "declarative-test-key" });
    assert.equal(models.length, 1);
    assert.equal(models[0].id, "ollama-default");
    assert.equal(models[0].provider, "ollama");

    const chat = await gateway.routeChat(
      {
        model: "ollama-default",
        messages: [{ role: "human", content: "hi from config" }]
      },
      { "x-api-key": "declarative-test-key" }
    );
    assert.equal(chat.message.content, "ollama-chat(llama3.2): hi from config");

    // Missing API key env var must fail closed (throw), never fall back to anonymous
    assert.throws(
      () =>
        fw.createGatewayFromConfig(
          {
            auth: { apiKeys: [{ id: "svc", keyEnv: "MISSING_GW_KEY", roles: ["runner"] }] }
          },
          {}
        ),
      /Missing API key in environment variable "MISSING_GW_KEY"/
    );
  } finally {
    await mockOllama.close();
  }
});

test("AgentGateway enforces pre-invocation token budgets and stateful regex guardrails", async () => {
  let paidCalls = 0;
  const gateway = new fw.AgentGateway({
    allowAnonymous: true,
    budgetManager: new fw.BudgetManager({ limits: [{ name: "total_tokens", max: 0 }] }),
    guardrails: [
      fw.createPatternGuardrail({
        id: "global-flag-guard",
        patterns: [/blocked-term/g]
      })
    ],
    llmBackends: [
      {
        id: "paid-model",
        provider: "mock",
        model: "mock-1",
        chatModel: {
          generate: async () => {
            paidCalls += 1;
            return { generations: [[{ text: "ok" }]], llmOutput: { usage: { total_tokens: 10 } } };
          }
        }
      }
    ]
  });

  // Pre-invocation budget check prevents calling the paid model at all
  await assert.rejects(
    () => gateway.routeChat({ model: "paid-model", messages: [{ role: "human", content: "hello" }] }),
    (err) => err.code === "BUDGET_EXCEEDED"
  );
  assert.equal(paidCalls, 0);

  // Global-flag regex guardrail blocks consistently on repeated invocations
  const guard = fw.createPatternGuardrail({ id: "g", patterns: [/secret-phrase/g] });
  assert.equal((await guard.inspect({ payload: "secret-phrase" })).allowed, false);
  assert.equal((await guard.inspect({ payload: "secret-phrase" })).allowed, false);
});

test("AgentGateway cancelTask aborts running A2A handler via AbortSignal", async () => {
  let signalAborted = false;
  let continuedAfterCancel = false;
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });

  const gateway = new fw.AgentGateway({ allowAnonymous: true });
  gateway.registerAgent({
    card: { id: "slow-agent", name: "Slow Agent", description: "Slow worker", version: "0.1.0" },
    handler: async (_req, ctx) => {
      startedResolve();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          continuedAfterCancel = true;
          resolve();
        }, 500);
        ctx.signal?.addEventListener(
          "abort",
          () => {
            signalAborted = true;
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true }
        );
      });
      return "should not finish";
    }
  });

  const taskPromise = gateway.sendTask({ id: "task-cancel-1", agentId: "slow-agent", input: "go" });
  await started;
  const canceled = await gateway.cancelTask("task-cancel-1");
  assert.equal(canceled.state, "canceled");
  const settled = await taskPromise;
  assert.equal(settled.state, "canceled");
  assert.equal(signalAborted, true);
  assert.equal(continuedAfterCancel, false);
});

test("ChatOllama stream enforces timeout across delayed streaming body chunks", async () => {
  const delayedServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "part1" }, done: false }) + "\n");
    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        res.end(JSON.stringify({ message: { content: "part2" }, done: true }) + "\n");
      }
    }, 150);
    res.on("close", () => clearTimeout(timer));
  });

  await new Promise((resolve) => delayedServer.listen(0, "127.0.0.1", resolve));
  const { port } = delayedServer.address();

  try {
    const chat = new fw.ChatOllama({
      model: "llama3.2",
      baseUrl: `http://127.0.0.1:${port}`,
      timeout: 25
    });
    const chunks = [];
    await assert.rejects(() =>
      chat.stream([{ role: "human", content: "stream" }], (chunk) => {
        chunks.push(chunk.text);
      })
    );
    assert.ok(!chunks.includes("part2"));
  } finally {
    await new Promise((resolve, reject) => delayedServer.close((err) => (err ? reject(err) : resolve())));
  }
});
