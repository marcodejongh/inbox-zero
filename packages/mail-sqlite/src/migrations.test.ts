import { describe, expect, it } from "vitest";
import { MAILBOX_SCHEMA_SQL, migrateMailbox } from "./migrations";
import { createNodeSqliteDriver } from "./node-sqlite";

describe("Fastmail mailbox migration", () => {
  it.each([
    false,
    true,
  ])("accepts Fastmail and preserves references (legacy=%s)", async (legacy) => {
    const driver = createNodeSqliteDriver();
    try {
      await driver.write(async (tx) => {
        await tx.exec(
          legacy
            ? MAILBOX_SCHEMA_SQL.replace(", 'fastmail'", "")
            : MAILBOX_SCHEMA_SQL,
        );
        await tx.exec(
          "INSERT INTO accounts(account_id, provider, generation, assistant_cursor) VALUES ('existing', 'google', 'g1', 'cursor')",
        );
        await tx.exec(
          "CREATE TABLE migration_reference (account_id TEXT REFERENCES accounts(account_id)); INSERT INTO migration_reference VALUES ('existing')",
        );
      });
      await driver.write((tx) => migrateMailbox(tx, "epoch"));
      await driver.write(async (tx) => {
        await tx.exec(
          "INSERT INTO accounts(account_id, provider, generation) VALUES ('fastmail', 'fastmail', 'g1')",
        );
      });
      await driver.write((tx) => migrateMailbox(tx, "epoch"));
      await driver.read(async (tx) => {
        expect(
          await tx.query(
            "SELECT provider, assistant_cursor FROM accounts WHERE account_id = 'existing'",
          ),
        ).toEqual([{ provider: "google", assistant_cursor: "cursor" }]);
        expect(
          await tx.query("SELECT account_id FROM migration_reference"),
        ).toEqual([{ account_id: "existing" }]);
        expect(await tx.query("PRAGMA foreign_key_check")).toEqual([]);
        expect(await tx.query("PRAGMA foreign_keys")).toEqual([
          { foreign_keys: 1 },
        ]);
      });
    } finally {
      await driver.close();
    }
  });
});
