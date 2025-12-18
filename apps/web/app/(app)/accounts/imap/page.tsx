"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, CheckCircle, XCircle, Loader2, Mail, Server } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastSuccess, toastError } from "@/components/Toast";
import { PageHeader } from "@/components/PageHeader";
import { PageWrapper } from "@/components/PageWrapper";
import { EMAIL_PROVIDER_PRESETS, type EmailProviderPreset } from "@/utils/imap/types";

const formSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  name: z.string().optional(),
  imapHost: z.string().min(1, "IMAP host is required"),
  imapPort: z.coerce.number().int().positive("IMAP port must be a positive number"),
  imapUsername: z.string().min(1, "IMAP username is required"),
  imapPassword: z.string().min(1, "IMAP password is required"),
  imapSecurity: z.enum(["ssl", "tls", "none"]),
  smtpHost: z.string().min(1, "SMTP host is required"),
  smtpPort: z.coerce.number().int().positive("SMTP port must be a positive number"),
  smtpUsername: z.string().min(1, "SMTP username is required"),
  smtpPassword: z.string().min(1, "SMTP password is required"),
  smtpSecurity: z.enum(["ssl", "tls", "none"]),
});

type FormData = z.infer<typeof formSchema>;

export default function ImapSetupPage() {
  const router = useRouter();
  const [isTesting, setIsTesting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [testResults, setTestResults] = useState<{
    imap: { success: boolean; error?: string } | null;
    smtp: { success: boolean; error?: string } | null;
  }>({ imap: null, smtp: null });

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      name: "",
      imapHost: "",
      imapPort: 993,
      imapUsername: "",
      imapPassword: "",
      imapSecurity: "ssl",
      smtpHost: "",
      smtpPort: 587,
      smtpUsername: "",
      smtpPassword: "",
      smtpSecurity: "tls",
    },
  });

  const applyPreset = (presetKey: string) => {
    const preset = EMAIL_PROVIDER_PRESETS[presetKey];
    if (!preset) return;

    form.setValue("imapHost", preset.imapHost);
    form.setValue("imapPort", preset.imapPort);
    form.setValue("imapSecurity", preset.imapSecurity);
    form.setValue("smtpHost", preset.smtpHost);
    form.setValue("smtpPort", preset.smtpPort);
    form.setValue("smtpSecurity", preset.smtpSecurity);
  };

  const testConnection = async () => {
    const values = form.getValues();
    const result = formSchema.safeParse(values);

    if (!result.success) {
      toastError({
        title: "Invalid form",
        description: "Please fill in all required fields correctly.",
      });
      return;
    }

    setIsTesting(true);
    setTestResults({ imap: null, smtp: null });

    try {
      const response = await fetch("/api/imap/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      setTestResults(data.results);

      if (data.success) {
        toastSuccess({
          title: "Connection successful",
          description: "Both IMAP and SMTP connections are working.",
        });
      } else {
        toastError({
          title: "Connection test failed",
          description: "Please check the errors below and try again.",
        });
      }
    } catch (error) {
      toastError({
        title: "Connection test failed",
        description: "An error occurred while testing the connection.",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const onSubmit = async (values: FormData) => {
    setIsCreating(true);

    try {
      const response = await fetch("/api/imap/create-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const data = await response.json();

      if (response.ok) {
        toastSuccess({
          title: "Account created",
          description: `Your email account ${values.email} has been added successfully.`,
        });
        router.push("/accounts");
      } else {
        toastError({
          title: "Failed to create account",
          description: data.error || "An error occurred while creating the account.",
        });
      }
    } catch (error) {
      toastError({
        title: "Failed to create account",
        description: "An error occurred while creating the account.",
      });
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <PageWrapper>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/accounts">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Accounts
          </Link>
        </Button>
      </div>

      <PageHeader
        title="Add IMAP/SMTP Account"
        description="Connect any email account using IMAP and SMTP"
      />

      <div className="mx-auto max-w-2xl py-6">
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Quick Setup
            </CardTitle>
            <CardDescription>
              Select your email provider to auto-fill server settings
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(EMAIL_PROVIDER_PRESETS)
                .filter(([key]) => key !== "custom")
                .map(([key, preset]) => (
                  <Button
                    key={key}
                    variant="outline"
                    size="sm"
                    onClick={() => applyPreset(key)}
                  >
                    {preset.name}
                  </Button>
                ))}
            </div>
          </CardContent>
        </Card>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5" />
                  Account Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email Address</FormLabel>
                      <FormControl>
                        <Input placeholder="you@example.com" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Display Name (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Your Name" {...field} />
                      </FormControl>
                      <FormDescription>
                        This name will be shown in the accounts list
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>IMAP Settings (Incoming Mail)</CardTitle>
                <CardDescription>
                  Configure your incoming mail server settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="imapHost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>IMAP Server</FormLabel>
                        <FormControl>
                          <Input placeholder="imap.example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="imapPort"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Port</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="993" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="imapUsername"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input placeholder="you@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="imapPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" placeholder="••••••••" {...field} />
                        </FormControl>
                        <FormDescription>
                          Use an app-specific password if available
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="imapSecurity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Security</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select security type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ssl">SSL/TLS (Recommended)</SelectItem>
                          <SelectItem value="tls">STARTTLS</SelectItem>
                          <SelectItem value="none">None (Not recommended)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {testResults.imap && (
                  <div
                    className={`flex items-center gap-2 rounded-md p-3 text-sm ${
                      testResults.imap.success
                        ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
                        : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                    }`}
                  >
                    {testResults.imap.success ? (
                      <CheckCircle className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {testResults.imap.success
                      ? "IMAP connection successful"
                      : `IMAP error: ${testResults.imap.error}`}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>SMTP Settings (Outgoing Mail)</CardTitle>
                <CardDescription>
                  Configure your outgoing mail server settings
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="smtpHost"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>SMTP Server</FormLabel>
                        <FormControl>
                          <Input placeholder="smtp.example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="smtpPort"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Port</FormLabel>
                        <FormControl>
                          <Input type="number" placeholder="587" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="smtpUsername"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Username</FormLabel>
                        <FormControl>
                          <Input placeholder="you@example.com" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="smtpPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" placeholder="••••••••" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="smtpSecurity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Security</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select security type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ssl">SSL/TLS</SelectItem>
                          <SelectItem value="tls">STARTTLS (Recommended)</SelectItem>
                          <SelectItem value="none">None (Not recommended)</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {testResults.smtp && (
                  <div
                    className={`flex items-center gap-2 rounded-md p-3 text-sm ${
                      testResults.smtp.success
                        ? "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300"
                        : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                    }`}
                  >
                    {testResults.smtp.success ? (
                      <CheckCircle className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    {testResults.smtp.success
                      ? "SMTP connection successful"
                      : `SMTP error: ${testResults.smtp.error}`}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-end gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={testConnection}
                disabled={isTesting || isCreating}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test Connection"
                )}
              </Button>
              <Button type="submit" disabled={isTesting || isCreating}>
                {isCreating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Account"
                )}
              </Button>
            </div>
          </form>
        </Form>
      </div>
    </PageWrapper>
  );
}
