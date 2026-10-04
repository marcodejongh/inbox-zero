import { strict as assert } from "node:assert/strict";
import { test } from "node:test";
import {
  FastmailEventSourceClient,
  buildEventSourceUrl,
  readEmailState,
} from "./eventsource-client.js";

test("expands the JMAP EventSource template and requests a persistent connection", () => {
  const url = new URL(
    buildEventSourceUrl(
      "https://api.fastmail.com/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}",
    ),
  );
  assert.equal(url.searchParams.get("types"), "Email,Mailbox");
  assert.equal(url.searchParams.get("closeafter"), "no");
  assert.equal(url.searchParams.get("ping"), "60");
  assert.equal(url.toString().includes("%7B"), false);
});
test("accepts only Email changes for the connected account", () => {
  assert.equal(
    readEmailState(
      { "@type": "StateChange", changed: { account: { Email: "s2" } } },
      "account",
    ),
    "s2",
  );
  assert.equal(
    readEmailState(
      { "@type": "StateChange", changed: { other: { Email: "s2" } } },
      "account",
    ),
    undefined,
  );
  assert.equal(
    readEmailState(
      { "@type": "StateChange", changed: { account: { Mailbox: "s2" } } },
      "account",
    ),
    undefined,
  );
  assert.equal(
    readEmailState(
      { "@type": "Other", changed: { account: { Email: "s2" } } },
      "account",
    ),
    undefined,
  );
});

test("reconnects with a rotated token, catches up on connection, and stops cleanly", async (context) => {
  const authorizations: string[] = [];
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let connected = 0;
  const states: string[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init: RequestInit) => {
      authorizations.push(new Headers(init.headers).get("authorization") ?? "");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const client = new FastmailEventSourceClient({
    accessToken: "first",
    accountId: "account",
    emailAccountId: "local",
    eventSourceUrl: "https://api.fastmail.com/events",
    onConnected: () => {
      connected++;
    },
    onStateChange: (_, state) => states.push(state),
  });
  try {
    client.connect();
    await settle();
    streamController?.enqueue(
      new TextEncoder().encode(
        'event: state\ndata: {"@type":"StateChange","changed":{"account":{"Email":"s2"}}}\n\n',
      ),
    );
    await settle();
    assert.deepEqual(states, ["s2"]);
    client.updateAccessToken("second");
    await settle();
    assert.equal(connected, 2);
    assert.deepEqual(authorizations, ["Bearer first", "Bearer second"]);
    client.close();
    client.connect();
    await settle();
    assert.equal(authorizations.length, 2);
    assert.equal(client.isConnected(), false);
  } finally {
    client.close();
  }
});

function settle() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
