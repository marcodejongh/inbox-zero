import { SafeError } from "@/utils/error";

type Mailbox = { id: string; name: string; role?: string | null };
type Filter = Record<string, unknown>;

export function parseFastmailSearchQuery(
  query: string,
  mailboxes: Mailbox[],
  now = new Date(),
) {
  const tokens = tokenize(query);
  let index = 0;
  let includeSpamTrash = false;

  // Gmail precedence: OR joins adjacent terms and binds tighter than the
  // implicit AND between the rest.
  const parseSequence = (grouped: boolean) => {
    const conditions: Filter[] = [];
    while (index < tokens.length && tokens[index] !== ")") {
      const alternatives = parseOperand();
      while (tokens[index] === "OR") {
        index++;
        alternatives.push(...parseOperand());
      }
      if (alternatives.length > 1)
        conditions.push({ operator: "OR", conditions: alternatives });
      else conditions.push(...alternatives);
    }
    if (grouped ? tokens[index] !== ")" : index < tokens.length)
      throw new SafeError("Unbalanced parentheses in Fastmail search.");
    return conditions;
  };

  const parseOperand = (): Filter[] => {
    const token = tokens[index++];
    if (token === undefined || token === "OR" || token === ")")
      throw new SafeError(
        "OR needs a search term on both sides in Fastmail searches.",
      );
    if (token === "(") {
      const conditions = parseSequence(true);
      index++;
      if (!conditions.length)
        throw new SafeError("Fastmail search filters need a value.");
      return [
        conditions.length === 1
          ? conditions[0]
          : { operator: "AND", conditions },
      ];
    }
    const term = parseTerm(token, mailboxes, now);
    if (term.includeSpamTrash) includeSpamTrash = true;
    return term.condition ? [term.condition] : [];
  };

  const conditions = parseSequence(false);
  return {
    filter: conditions.length ? { operator: "AND", conditions } : {},
    includeSpamTrash,
  };
}

function parseTerm(
  token: string,
  mailboxes: Mailbox[],
  now: Date,
): { condition?: Filter; includeSpamTrash?: boolean } {
  let includeSpamTrash = false;
  const negated = token.startsWith("-");
  const term = negated ? token.slice(1) : token;
  const prefix = /^[a-z_]+:/i.exec(term)?.[0];
  const field = prefix ? prefix.slice(0, -1).toLowerCase() : "text";
  const value = (prefix ? term.slice(prefix.length) : term).replace(
    /"((?:\\.|[^"\\])*)"/g,
    (_, quotedValue: string) => quotedValue.replace(/\\(.)/g, "$1"),
  );
  if (!value) throw new SafeError("Fastmail search filters need a value.");
  let condition: Filter;
  switch (field) {
    case "text":
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
      condition = { [field]: value };
      break;
    case "is":
      if (value === "unread") condition = { notKeyword: "$seen" };
      else if (value === "read") condition = { hasKeyword: "$seen" };
      else if (value === "starred") condition = { hasKeyword: "$flagged" };
      else
        throw new SafeError(
          "Fastmail supports is:read, is:unread, and is:starred.",
        );
      break;
    case "has":
      if (value !== "attachment")
        throw new SafeError("Fastmail supports has:attachment.");
      condition = { hasAttachment: true };
      break;
    case "in":
    case "label": {
      if (field === "in" && value === "anywhere" && !negated)
        return { includeSpamTrash: true };
      const role =
        value === "spam" ? "junk" : value === "draft" ? "drafts" : value;
      const mailbox = mailboxes.find(
        (mailbox) =>
          (field === "in" && mailbox.role === role) ||
          mailbox.name.toLowerCase() === value.toLowerCase() ||
          mailbox.id === value,
      );
      if (!mailbox)
        throw new SafeError(
          "Fastmail search mailbox was not found. Use a mailbox name or ID from listLabels.",
        );
      includeSpamTrash =
        !negated && (mailbox.role === "junk" || mailbox.role === "trash");
      condition = { inMailbox: mailbox.id };
      break;
    }
    case "after":
    case "before": {
      const date = value.replaceAll("/", "-");
      const parsed = new Date(`${date}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date
      ) {
        throw new SafeError(
          "Use a valid YYYY/MM/DD date in Fastmail searches.",
        );
      }
      condition = { [field]: parsed.toISOString() };
      break;
    }
    case "newer_than":
    case "older_than": {
      const age = /^(\d+)([dmy])$/.exec(value);
      if (!age)
        throw new SafeError(
          "Use a number followed by d, m, or y for relative search dates.",
        );
      const daysByUnit: Record<string, number> = { d: 1, m: 30, y: 365 };
      const days = daysByUnit[age[2]];
      const date = new Date(now.getTime() - Number(age[1]) * days * 86_400_000);
      if (!Number.isFinite(date.getTime()))
        throw new SafeError("Invalid relative search date.");
      condition = {
        [field === "newer_than" ? "after" : "before"]: date.toISOString(),
      };
      break;
    }
    default:
      throw new SafeError(
        `Unsupported Fastmail search operator: ${field}. Use from:, to:, subject:, in:, label:, is:unread, has:attachment, or date filters.`,
      );
  }
  return {
    condition: negated
      ? { operator: "NOT", conditions: [condition] }
      : condition,
    includeSpamTrash,
  };
}

function tokenize(query: string) {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const character of query) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quoted) {
      token += character;
      escaped = true;
    } else if (character === '"') {
      token += character;
      quoted = !quoted;
    } else if (!quoted && /\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else if (!quoted && "{}".includes(character)) {
      throw new SafeError(
        "Braces are not supported in Fastmail searches. Use OR between terms instead.",
      );
    } else if (!quoted && character === "(") {
      if (token)
        throw new SafeError(
          "Parentheses can only group whole terms in Fastmail searches. Write from:a OR from:b instead of from:(a OR b).",
        );
      tokens.push(character);
    } else if (!quoted && character === ")") {
      if (token) tokens.push(token);
      token = "";
      tokens.push(character);
    } else {
      token += character;
    }
  }
  if (quoted || escaped)
    throw new SafeError("Unclosed quote in Fastmail search.");
  if (token) tokens.push(token);
  return tokens;
}
