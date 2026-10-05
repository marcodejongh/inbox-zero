/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUseSWR = vi.fn();
const mockProgressPanel = vi.fn();

(globalThis as { React?: typeof React }).React = React;

vi.mock("swr", () => ({
  default: (...args: Parameters<typeof mockUseSWR>) => mockUseSWR(...args),
}));

vi.mock("@/components/ProgressPanel", () => ({
  ProgressPanel: (props: {
    totalItems: number;
    remainingItems: number;
    completedText: string;
  }) => {
    mockProgressPanel(props);
    return (
      <div>
        {props.remainingItems} remaining / {props.totalItems} total
      </div>
    );
  },
}));

vi.mock("@/utils/actions/categorize", () => ({
  bulkCategorizeSendersAction: vi.fn(),
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));

describe("CategorizeSendersProgress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  it("renders the real backend progress without faking additional completed items", async () => {
    mockUseSWR.mockReturnValue({
      data: { totalItems: 10, completedItems: 4 },
    });

    const { CategorizeSendersProgress } = await import(
      "@/app/(app)/[emailAccountId]/smart-categories/CategorizeProgress"
    );

    render(<CategorizeSendersProgress refresh />);

    expect(screen.getByText("6 remaining / 10 total")).toBeTruthy();
    expect(mockProgressPanel).toHaveBeenCalledWith(
      expect.objectContaining({
        totalItems: 10,
        remainingItems: 6,
        completedText: "Categorization complete! 4 categorized!",
      }),
    );
  });

  it("counts failed senders as processed and offers a retry once the run ends", async () => {
    mockUseSWR.mockReturnValue({
      data: { totalItems: 10, completedItems: 7, failedItems: 3 },
    });

    const { CategorizeSendersProgress } = await import(
      "@/app/(app)/[emailAccountId]/smart-categories/CategorizeProgress"
    );

    render(<CategorizeSendersProgress refresh />);

    expect(screen.getByText("0 remaining / 10 total")).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeTruthy();
  });

  it("does not offer a retry while senders are still being categorized", async () => {
    mockUseSWR.mockReturnValue({
      data: { totalItems: 10, completedItems: 4, failedItems: 3 },
    });

    const { CategorizeSendersProgress } = await import(
      "@/app/(app)/[emailAccountId]/smart-categories/CategorizeProgress"
    );

    render(<CategorizeSendersProgress refresh />);

    expect(screen.getByText("3 remaining / 10 total")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});
