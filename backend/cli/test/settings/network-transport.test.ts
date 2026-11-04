import { expect, test } from "bun:test"
import { createServer, type RequestListener } from "node:http"
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib"
import { Network } from "../../src/settings/network"
import { clearCache, request, withHttpTestPolicy } from "../../src/science/connectors/http"

async function fixture(listener: RequestListener) {
  const server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  return {
    url: new URL(`http://public.example:${address.port}/record`),
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test.each([false, true])(
  "refused connections reject once without an unhandled teardown error (stream=%s)",
  async (stream) => {
    const closed = await fixture((_request, response) => response.end("unused"))
    await closed[Symbol.asyncDispose]()
    const target = new URL(closed.url)
    target.protocol = "https:"
    await expect(Network.pinnedFetch(target, {}, "127.0.0.1", undefined, stream)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    })
    // Bun emits the teardown error on a later tick, after the first rejection.
    await Bun.sleep(0)
  },
)

test("socket failure after streamed headers rejects the body without escaping its consumer", async () => {
  const stop = Promise.withResolvers<() => void>()
  await using server = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "application/pdf", "content-length": 1000 })
    response.flushHeaders()
    response.write("%PDF-partial")
    stop.resolve(() => response.socket!.destroy())
  })
  const response = await Network.pinnedFetch(server.url, {}, "127.0.0.1", undefined, true)
  const reading = response.text().then(
    () => undefined,
    (error: unknown) => error,
  )
  const interrupt = await stop.promise
  interrupt()
  expect(await reading).toBeInstanceOf(Error)
  await Bun.sleep(0)
})

test.each([false, true])("chunked response limits cover actual bytes (stream=%s)", async (stream) => {
  await using server = await fixture((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" })
    response.write("1234")
    response.end("5678")
  })
  await expect(
    Network.pinnedFetch(server.url, {}, "127.0.0.1", 5, stream).then((response) => response.text()),
  ).rejects.toMatchObject({ name: "ResponseTooLargeError", limitBytes: 5 })
})

test.each([false, true])("compressed responses are decoded and bounded (stream=%s)", async (stream) => {
  for (const [coding, compress] of [
    ["gzip", (input: string) => gzipSync(input)],
    ["deflate", (input: string) => deflateSync(input)],
    ["br", (input: string) => brotliCompressSync(input)],
  ] as const) {
    const payload = JSON.stringify({ data: "x".repeat(500) })
    const compressed = compress(payload)
    await using server = await fixture((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": coding,
        "content-length": compressed.byteLength,
      })
      response.end(compressed)
    })
    const response = await Network.pinnedFetch(server.url, {}, "127.0.0.1", 1024, stream)
    expect(await response.json()).toEqual(JSON.parse(payload))
    expect(response.headers.has("content-encoding")).toBe(false)
    expect(response.headers.has("content-length")).toBe(false)
    await expect(
      Network.pinnedFetch(server.url, {}, "127.0.0.1", 128, stream).then((res) => res.text()),
    ).rejects.toMatchObject({ name: "ResponseTooLargeError", limitBytes: 128 })
  }
})

test.each([false, true])("malformed compressed responses reject (stream=%s)", async (stream) => {
  await using server = await fixture((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" })
    response.end("not a gzip stream")
  })
  await expect(
    Network.pinnedFetch(server.url, {}, "127.0.0.1", undefined, stream).then((res) => res.text()),
  ).rejects.toThrow()
})

test.each([false, true])(
  "aborting a partial body rejects instead of returning truncated data (stream=%s)",
  async (stream) => {
    const started = Promise.withResolvers<void>()
    await using server = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" })
      response.write("PARTIAL")
      started.resolve()
    })
    const controller = new AbortController()
    const reading = Network.pinnedFetch(server.url, { signal: controller.signal }, "127.0.0.1", undefined, stream).then(
      (res) => res.text(),
    )
    await started.promise
    controller.abort(new Error("fixture abort"))
    await expect(reading).rejects.toThrow("fixture abort")
  },
)

test("DNS cancellation returns before resolution and never opens a late socket", async () => {
  const dns = Promise.withResolvers<readonly string[]>()
  const started = Promise.withResolvers<void>()
  const controller = new AbortController()
  const calls = { transport: 0 }
  const pending = Network.fetch(
    "https://example.com/record",
    { signal: controller.signal },
    {
      resolveAddresses() {
        started.resolve()
        return dns.promise
      },
      async transport() {
        calls.transport++
        return new Response("unexpected")
      },
    },
  )
  await started.promise
  controller.abort(new Error("cancel DNS"))
  await expect(
    Promise.race([
      pending,
      Bun.sleep(1000).then(() => {
        throw new Error("DNS cancellation hung")
      }),
    ]),
  ).rejects.toThrow("cancel DNS")
  dns.resolve(["1.1.1.1"])
  await Bun.sleep(0)
  expect(calls.transport).toBe(0)
})

test("connector timeouts cannot seed the response cache", async () => {
  clearCache()
  const calls = { count: 0 }
  await using server = await fixture((_request, response) => {
    calls.count++
    response.writeHead(200, { "content-type": "text/plain" })
    response.write("PARTIAL")
  })
  await withHttpTestPolicy(
    {
      resolveAddresses: async () => ["1.1.1.1"],
      transport: (target, init) => Network.pinnedFetch(target, init, "127.0.0.1"),
    },
    async () => {
      for (const _ of [0, 1]) await expect(request(server.url.href, { timeout: 40, retries: 0 })).rejects.toThrow()
    },
  )
  expect(calls.count).toBe(2)
  clearCache()
})

test("connector policy refusals do not spend a retry budget", async () => {
  const calls = { dns: 0 }
  await expect(
    request("https://example.com/private", {
      retries: 3,
      resolveAddresses: async () => {
        calls.dns++
        return ["198.18.0.30"]
      },
    }),
  ).rejects.toBeInstanceOf(Network.PolicyError)
  expect(calls.dns).toBe(1)
})

test("public DNS transport bypasses synthetic system addresses without permitting private destinations", async () => {
  const calls: string[] = []
  await using server = await fixture((request, response) => {
    const type = new URL(request.url!, "http://fixture.test").searchParams.get("type")
    response.writeHead(200, { "content-type": "application/dns-json" })
    response.end(
      JSON.stringify({
        Status: 0,
        Answer: [{ type: Number(type), data: type === "1" ? "1.1.1.1" : "2606:4700:4700::1111" }],
      }),
    )
  })
  const addresses = await Network.cloudflareResolve("example.com", undefined, (target, init, address, limit) => {
    expect(target.origin).toBe("https://cloudflare-dns.com")
    expect(address).toBe("1.1.1.1")
    expect(new Headers(init.headers).get("accept")).toBe("application/dns-json")
    expect(limit).toBe(65536)
    calls.push(target.searchParams.get("type")!)
    const local = new URL(server.url)
    local.search = target.search
    return Network.pinnedFetch(local, init, "127.0.0.1", limit)
  })
  expect(new Set(calls)).toEqual(new Set(["1", "28"]))
  expect(addresses).toEqual(["1.1.1.1", "2606:4700:4700::1111"])
  await expect(
    Network.fetch(
      "https://example.com",
      {},
      {
        resolveAddresses: async () => ["198.18.0.30"],
        transport: async () => {
          throw new Error("must not connect")
        },
      },
    ),
  ).rejects.toBeInstanceOf(Network.PolicyError)
  await expect(
    Network.fetch(
      "https://example.com",
      {},
      {
        resolveAddresses: async () => [...addresses, "169.254.169.254"],
        transport: async () => {
          throw new Error("must not connect")
        },
      },
    ),
  ).rejects.toBeInstanceOf(Network.PolicyError)
})

test("AliDNS uses its pinned HTTPS endpoint and accepts an empty AAAA answer", async () => {
  const calls: string[] = []
  await using server = await fixture((request, response) => {
    const type = new URL(request.url!, "http://fixture.test").searchParams.get("type")
    response.writeHead(200, { "content-type": "application/dns-json" })
    response.end(
      JSON.stringify({
        Status: 0,
        TC: false,
        ...(type === "A"
          ? {
              Answer: [
                { type: 1, data: "8.8.8.8" },
                { type: 1, data: "8.8.8.8" },
              ],
            }
          : {}),
      }),
    )
  })
  const addresses = await Network.alidnsResolve("api.example.com", undefined, (target, init, address, limit) => {
    expect(target.origin).toBe("https://dns.alidns.com")
    expect(target.pathname).toBe("/resolve")
    expect(target.searchParams.get("name")).toBe("api.example.com")
    expect(address).toBe("223.5.5.5")
    expect(new Headers(init.headers).get("accept")).toBe("application/dns-json")
    expect(limit).toBe(65536)
    calls.push(target.searchParams.get("type")!)
    const local = new URL(server.url)
    local.search = target.search
    return Network.pinnedFetch(local, init, "127.0.0.1", limit)
  })
  expect(new Set(calls)).toEqual(new Set(["A", "AAAA"]))
  expect(addresses).toEqual(["8.8.8.8"])
})

test("AliDNS answers retain public-address checks and malformed results fail closed", async () => {
  const unsafe = await Network.alidnsResolve("api.example.com", undefined, async (target) =>
    Response.json({
      Status: 0,
      Answer: target.searchParams.get("type") === "A" ? [{ type: 1, data: "198.18.0.30" }] : [],
    }),
  )
  let connected = false
  await expect(
    Network.fetch(
      "https://api.example.com/paper",
      {},
      {
        resolveAddresses: async () => unsafe,
        transport: async () => {
          connected = true
          return new Response("unexpected")
        },
      },
    ),
  ).rejects.toBeInstanceOf(Network.PolicyError)
  expect(connected).toBe(false)
  for (const data of [{ Status: 2 }, { Status: 0, TC: true }, { Status: 0, Answer: [{ type: 1, data: "not-an-IP" }] }])
    await expect(Network.alidnsResolve("api.example.com", undefined, async () => Response.json(data))).rejects.toThrow()
})

test("cancelling a streamed response closes its upstream socket", async () => {
  const closed = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("pending"))
          },
          cancel() {
            closed.resolve()
          },
        }),
        { status: 404 },
      )
    },
  })
  try {
    const response = await Network.pinnedFetch(new URL(server.url), {}, "127.0.0.1", undefined, true)
    await response.body!.cancel()
    await Promise.race([
      closed.promise,
      Bun.sleep(1000).then(() => {
        throw new Error("Upstream socket remained open")
      }),
    ])
  } finally {
    server.stop(true)
  }
})
