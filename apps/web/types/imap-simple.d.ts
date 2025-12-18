/**
 * Type declarations for imap-simple
 */

declare module "imap-simple" {
  import type Imap from "imap";

  export interface ImapSimpleOptions {
    imap: Imap.Config;
  }

  export interface Message {
    attributes: {
      uid: number;
      flags: string[];
      date: Date;
      size: number;
    };
    parts: Array<{
      which: string;
      body: Buffer | string;
    }>;
  }

  export interface Box {
    name: string;
    messages: {
      total: number;
      new: number;
    };
    uidvalidity: number;
    uidnext: number;
    permFlags?: string[];
  }

  export interface ImapSimple {
    imap: Imap;
    openBox(mailbox: string, readOnly?: boolean): Promise<Box>;
    search(criteria: any[], options: any): Promise<Message[]>;
    addFlags(uid: number, flags: string[]): Promise<void>;
    delFlags(uid: number, flags: string[]): Promise<void>;
    moveMessage(uid: number, destination: string): Promise<void>;
    getBoxes(): Promise<Record<string, any>>;
    end(): void;
  }

  export function connect(options: ImapSimpleOptions): Promise<ImapSimple>;
}
