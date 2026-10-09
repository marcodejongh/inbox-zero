"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import type { z } from "zod";
import { FileArchiveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useDriveConnections } from "@/hooks/useDriveConnections";
import { connectPaperlessAction } from "@/utils/actions/paperless";
import { connectPaperlessBody } from "@/utils/actions/paperless.validation";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";

export function ConnectPaperless() {
  const [open, setOpen] = useState(false);
  const { data, mutate } = useDriveConnections();
  const connection = data?.connections.find(
    (item) => item.provider === "paperless",
  );
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <FileArchiveIcon className="size-4" />
        {connection ? "Reconnect Paperless" : "Connect Paperless"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect Paperless</DialogTitle>
          </DialogHeader>
          {open && (
            <ConnectionForm
              baseUrl={connection?.baseUrl || ""}
              onConnected={() => {
                setOpen(false);
                mutate();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ConnectionForm({
  baseUrl,
  onConnected,
}: {
  baseUrl: string;
  onConnected: () => void;
}) {
  const { emailAccountId } = useAccount();
  const form = useForm<z.infer<typeof connectPaperlessBody>>({
    resolver: zodResolver(connectPaperlessBody),
    defaultValues: { baseUrl, apiToken: "" },
  });
  const { execute, isExecuting } = useAction(
    connectPaperlessAction.bind(null, emailAccountId),
    {
      onSuccess: () => {
        form.reset();
        toastSuccess({
          description:
            "Paperless connected. Select it as your filing destination to start.",
        });
        onConnected();
      },
      onError: ({ error }) =>
        toastError({
          description:
            getActionErrorMessage(error) || "Could not connect Paperless.",
        }),
    },
  );
  return (
    <form onSubmit={form.handleSubmit(execute)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="paperless-url">Instance URL</Label>
        <Input
          id="paperless-url"
          type="url"
          placeholder="https://paperless.example.com"
          {...form.register("baseUrl")}
        />
        {form.formState.errors.baseUrl && (
          <p className="text-sm text-destructive">
            Enter a valid instance URL.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="paperless-token">API token</Label>
        <Input
          id="paperless-token"
          type="password"
          autoComplete="off"
          {...form.register("apiToken")}
        />
        {form.formState.errors.apiToken && (
          <p className="text-sm text-destructive">Enter your API token.</p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Create a token in Paperless’s My Profile menu. The user needs permission
        to view tasks and view/add documents.
      </p>
      <Button type="submit" loading={isExecuting}>
        Connect
      </Button>
    </form>
  );
}
