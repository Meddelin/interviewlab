import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  LogIn,
  Plus,
  RefreshCw,
  TerminalSquare,
  Trash2,
  Zap,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAsrDevice, useModels } from "@/lib/asr-queries";
import {
  adapterKeys,
  useActiveAdapter,
  useAdapterMeta,
  useAdapters,
  useDeletePlugin,
  usePluginManifestSchema,
  useSavePluginManifest,
  useTaskModel,
} from "@/lib/adapter-queries";
import { useUiStore } from "@/lib/ui-store";
import {
  DIAR_MODEL_PROGRESS_EVENT,
  diarizationModelsPresent,
  downloadDiarizationModels,
  IN_TAURI,
  MODEL_PROGRESS_EVENT,
  downloadModel,
  rescanPlugins,
  setActiveAdapter,
  setTaskModel,
  testCli,
  type AdapterSummary,
  type Capability,
  type DiarModelProgress,
  type ModelOption,
  type ModelProgress,
  type ProbeResult,
  type ProbeStatus,
  type TaskModelBucket,
} from "@/lib/tauri";
import { mockOnDiarModelProgress, mockOnModelProgress } from "@/lib/dev-mock";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { asrKeys } from "@/lib/asr-queries";
import { RolesSettings } from "@/components/roles-settings";
import { toast } from "sonner";

// §4.4 Settings: Tabs (AI CLI | Transcription | About). M4 fills the Transcription
// tab (device Badge, model Select + Download, language Select); M6 fills the AI CLI
// tab (adapter Cards, active Select, Test CLI probe, Add adapter… dialog).

// Languages the user can force (or auto-detect). Russian-first per spec §6.4.
const LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "ru", label: "Russian" },
  { value: "en", label: "English" },
];

// Expected-speaker choices for diarization: "auto" lets it detect the count, else force it.
// The value is the localStorage string; callers map "auto"→null for the backend's
// expectedSpeakers arg.
const EXPECTED_SPEAKERS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "2", label: "2 speakers" },
  { value: "3", label: "3 speakers" },
  { value: "4", label: "4 speakers" },
];

// A slim, dependency-free progress bar (no shadcn Progress component in the tree).
function Bar({ pct }: { pct: number }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-150"
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </div>
  );
}

function TranscriptionTab() {
  const { data: device, isPending: devicePending } = useAsrDevice();
  const { data: models, isPending: modelsPending } = useModels();
  const qc = useQueryClient();

  const asrModelId = useUiStore((s) => s.asrModelId);
  const setAsrModelId = useUiStore((s) => s.setAsrModelId);
  const asrLanguage = useUiStore((s) => s.asrLanguage);
  const setAsrLanguage = useUiStore((s) => s.setAsrLanguage);
  const asrExpectedSpeakers = useUiStore((s) => s.asrExpectedSpeakers);
  const setAsrExpectedSpeakers = useUiStore((s) => s.setAsrExpectedSpeakers);

  // Download progress for the currently-downloading model (model_id → percent).
  const [dl, setDl] = useState<{ id: string; pct: number } | null>(null);

  // Speaker diarization: are the model files present? + live step progress while the
  // diarization-model download runs (mirrors the ggml model download UX above).
  const { data: diarPresent, isPending: diarPending } = useQuery({
    queryKey: asrKeys.diarPresent,
    queryFn: diarizationModelsPresent,
  });
  const [diarDl, setDiarDl] = useState<DiarModelProgress | null>(null);

  const selected = models?.find((m) => m.id === asrModelId);

  // Subscribe to model-download progress (Tauri event, or the dev-mock bus).
  useEffect(() => {
    function onProgress(p: ModelProgress) {
      const pct =
        p.total_bytes > 0
          ? Math.round((p.downloaded_bytes / p.total_bytes) * 100)
          : p.done
            ? 100
            : 0;
      if (p.error) {
        toast.error(`Model download failed: ${p.error}`);
        setDl(null);
        return;
      }
      if (p.done) {
        setDl(null);
        // Refresh the catalog so the "Downloaded" badge flips on.
        qc.invalidateQueries({ queryKey: asrKeys.models });
        toast.success("Model downloaded");
      } else {
        setDl({ id: p.model_id, pct });
      }
    }

    if (!IN_TAURI) {
      return mockOnModelProgress(onProgress);
    }
    const unlisten = getCurrentWebview().listen<ModelProgress>(
      MODEL_PROGRESS_EVENT,
      (e) => onProgress(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [qc]);

  async function handleDownload() {
    if (!selected) return;
    setDl({ id: selected.id, pct: 0 });
    try {
      await downloadModel(selected.id);
    } catch (e) {
      toast.error(`Couldn't start the download. ${String(e)}`);
      setDl(null);
    }
  }

  // Subscribe to diarization-model download progress (Tauri event, or the dev-mock bus).
  // Step-level (segmentation + embedding files), so we show "label · step/total" not a %.
  useEffect(() => {
    function onDiar(p: DiarModelProgress) {
      if (p.error) {
        toast.error(`Diarization model download failed: ${p.error}`);
        setDiarDl(null);
        return;
      }
      if (p.done) {
        setDiarDl(null);
        // Refresh presence so the status line flips to "installed".
        qc.invalidateQueries({ queryKey: asrKeys.diarPresent });
        toast.success("Diarization models downloaded");
      } else {
        setDiarDl(p);
      }
    }

    if (!IN_TAURI) {
      return mockOnDiarModelProgress(onDiar);
    }
    const unlisten = getCurrentWebview().listen<DiarModelProgress>(
      DIAR_MODEL_PROGRESS_EVENT,
      (e) => onDiar(e.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [qc]);

  async function handleDownloadDiar() {
    setDiarDl({ step: 0, total_steps: 1, label: "Starting…", done: false, error: null });
    try {
      await downloadDiarizationModels();
    } catch (e) {
      toast.error(`Couldn't start the download. ${String(e)}`);
      setDiarDl(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-7 pt-2">
      {/* Device */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Compute device</span>
          <span className="text-xs text-muted-foreground">
            Whisper runs on the GPU when a CUDA build + Nvidia GPU are present, else CPU.
          </span>
        </div>
        {devicePending || !device ? (
          <Skeleton className="h-5 w-40" />
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Badge variant={device.use_gpu ? "default" : "secondary"}>
                {device.use_gpu ? (
                  <Zap className="size-3" />
                ) : (
                  <Cpu className="size-3" />
                )}
                {device.use_gpu ? "CUDA" : "CPU"}
              </Badge>
              {device.gpu_name && (
                <span className="text-xs text-muted-foreground">
                  {device.gpu_name}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{device.detail}</span>
          </div>
        )}
      </div>

      {/* Model */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Model</span>
          <span className="text-xs text-muted-foreground">
            large-v3 is the most accurate (best for Russian); turbo/medium trade some
            accuracy for speed.
          </span>
        </div>

        {modelsPending || !models ? (
          <Skeleton className="h-8 w-full max-w-xs" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={asrModelId} onValueChange={setAsrModelId}>
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selected?.downloaded ? (
                <Badge variant="outline">Downloaded</Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  disabled={!!dl}
                >
                  {dl && dl.id === selected?.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  Download model
                  {selected ? (
                    <span className="font-numeric text-xs text-muted-foreground">
                      {selected.approx_mb >= 1000
                        ? `${(selected.approx_mb / 1000).toFixed(1)} GB`
                        : `${selected.approx_mb} MB`}
                    </span>
                  ) : null}
                </Button>
              )}
            </div>

            {dl && selected && dl.id === selected.id && (
              <div className="flex max-w-xs flex-col gap-1">
                <Bar pct={dl.pct} />
                <span className="font-numeric text-[11px] text-muted-foreground">
                  Downloading… {dl.pct}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Language */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Language</span>
          <span className="text-xs text-muted-foreground">
            Force a language, or let Whisper detect it from the audio.
          </span>
        </div>
        <Select value={asrLanguage} onValueChange={setAsrLanguage}>
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder="Auto-detect" />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Speaker diarization */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            Speaker diarization
          </span>
          <span className="text-xs text-muted-foreground">
            Labels who spoke each segment (S1, S2, …) locally. Needs its own model files,
            separate from the transcription model above.
          </span>
        </div>

        {/* Status line + download. Mirrors the ggml model download UX (status → Download
            button → step progress while the files stream). */}
        <div className="flex flex-col gap-3">
          {diarPending ? (
            <Skeleton className="h-5 w-44" />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {diarPresent ? (
                <Badge variant="outline">
                  <CheckCircle2 className="size-3" />
                  Models installed
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <AlertCircle className="size-3" />
                  Not downloaded
                </Badge>
              )}
              {!diarPresent && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownloadDiar}
                  disabled={!!diarDl}
                >
                  {diarDl ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  Download diarization models
                </Button>
              )}
            </div>
          )}

          {diarDl && (
            <div className="flex max-w-xs flex-col gap-1">
              <Bar
                pct={
                  diarDl.total_steps > 0
                    ? Math.round((diarDl.step / diarDl.total_steps) * 100)
                    : 0
                }
              />
              <span className="font-numeric text-[11px] text-muted-foreground">
                {diarDl.label} · {diarDl.step}/{diarDl.total_steps}
              </span>
            </div>
          )}
        </div>

        {/* Expected speakers — persisted (asrExpectedSpeakers); the Transcribe / Re-diarize
            actions pass "auto"→null, else the forced count. */}
        <div className="mt-1 flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            Expected speakers
          </span>
          <Select value={asrExpectedSpeakers} onValueChange={setAsrExpectedSpeakers}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Auto-detect" />
            </SelectTrigger>
            <SelectContent>
              {EXPECTED_SPEAKERS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

// --- AI CLI tab (spec §4.4 / §7) ----------------------------------------------

// Map a probe status to its Badge styling + icon + label.
function probeBadge(status: ProbeStatus) {
  switch (status) {
    case "available":
      return {
        variant: "default" as const,
        icon: <CheckCircle2 className="size-3" />,
        label: "Available",
      };
    case "not-found":
      return {
        variant: "secondary" as const,
        icon: <AlertCircle className="size-3" />,
        label: "Not found",
      };
    case "not-logged-in":
      return {
        variant: "outline" as const,
        icon: <LogIn className="size-3" />,
        label: "Not logged in",
      };
    default:
      return {
        variant: "destructive" as const,
        icon: <AlertCircle className="size-3" />,
        label: "Error",
      };
  }
}

// Human-readable labels for the capability chips (feature-cli-plugins.md §3.1).
const CAPABILITY_LABELS: Record<Capability, string> = {
  "batch-tasks": "Batch",
  streaming: "Streaming",
  "multi-turn": "Multi-turn",
  "tool-use": "Tools",
};

// The mono "command · v… · vendor · auth: …" line, with empty pieces omitted.
function adapterMeta(adapter: AdapterSummary): string {
  return [
    adapter.command,
    adapter.version ? `v${adapter.version}` : "",
    adapter.vendor,
    adapter.auth_type ? `auth: ${adapter.auth_type}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// One plugin Card: name, the meta line, capability chips, a "runs external program"
// trust flag, and a per-plugin "Test CLI" probe with its own inline status Badge.
// A malformed plugin (ok === false) renders dimmed with its validation error and is
// neither testable nor selectable.
function AdapterCard({
  adapter,
  active,
}: {
  adapter: AdapterSummary;
  active: boolean;
}) {
  // Per-card probe state (each card holds its own result, independent of the global probe).
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const runProbe = useMutation({
    mutationFn: () => testCli(adapter.id),
    onSuccess: (r) => setProbe(r),
    onError: (e) => toast.error(`Test failed. ${String(e)}`),
  });
  const badge = probe ? probeBadge(probe.status) : null;

  // Delete a user (non-builtin) plugin, with a confirm. Builtin plugins show no button.
  const del = useDeletePlugin();
  function handleDelete() {
    if (!window.confirm(`Удалить плагин «${adapter.name}»? Папка plugins/${adapter.id} будет удалена.`))
      return;
    del.mutate(adapter.id, {
      onSuccess: () => toast.success("Плагин удалён"),
      onError: (e) => toast.error(`Не удалось удалить. ${String(e)}`),
    });
  }

  // Malformed manifest: surface the id + validation error so the user can fix the file.
  if (!adapter.ok) {
    return (
      <Card className="gap-3 border-destructive/40 opacity-70">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <TerminalSquare className="size-3.5 text-muted-foreground" />
              {adapter.id || "unknown"}
            </CardTitle>
            <Badge variant="destructive">
              <AlertCircle className="size-3" />
              Invalid
            </Badge>
          </div>
          {adapter.error && (
            <CardDescription className="text-[11px] text-destructive">
              {adapter.error}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {adapter.source && (
            <span className="font-numeric text-[10px] text-muted-foreground">
              {adapter.source}
            </span>
          )}
          {!adapter.builtin && (
            <Button
              variant="outline"
              size="sm"
              className="self-start text-destructive"
              onClick={handleDelete}
              disabled={del.isPending}
            >
              {del.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Удалить
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <TerminalSquare className="size-3.5 text-muted-foreground" />
            {adapter.name}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {adapter.builtin && <Badge variant="outline">Default</Badge>}
            {active && <Badge variant="default">Active</Badge>}
          </div>
        </div>
        <CardDescription className="font-numeric text-[11px]">
          {adapterMeta(adapter)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {adapter.capabilities.map((c) => (
            <span
              key={c}
              className="rounded-full bg-secondary px-2 py-0.5 font-numeric text-[10px] text-muted-foreground"
            >
              {CAPABILITY_LABELS[c]}
            </span>
          ))}
          {adapter.runs_external_program && (
            <span className="rounded-full border border-status-importing/40 px-2 py-0.5 font-numeric text-[10px] text-status-importing">
              runs external program
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runProbe.mutate()}
            disabled={runProbe.isPending}
          >
            {runProbe.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <TerminalSquare className="size-3.5" />
            )}
            Test CLI
          </Button>
          {badge && (
            <Badge variant={badge.variant}>
              {badge.icon}
              {badge.label}
            </Badge>
          )}
          {!adapter.builtin && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
              disabled={del.isPending}
              title="Удалить плагин"
            >
              {del.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// The descriptor-level form state the manual builder collects. Args/probe are entered as
// space-or-newline-separated tokens (the common shape); `models` is one "id label" per line.
type PluginForm = {
  id: string;
  name: string;
  vendor: string;
  version: string;
  command: string;
  args: string; // the batch task args template (one token per line / space-separated)
  probeArgs: string; // the probe args (e.g. "--version")
  resultPath: string; // io.result_extract.json_path (the envelope field, e.g. "result")
  capabilities: Capability[];
  models: string; // one "id label…" per line (optional)
};

const EMPTY_PLUGIN_FORM: PluginForm = {
  id: "",
  name: "",
  vendor: "",
  version: "",
  command: "",
  args: "-p {prompt} --output-format json",
  probeArgs: "--version",
  resultPath: "result",
  capabilities: ["batch-tasks"],
  models: "",
};

// All capabilities the form can tick. Batch-tasks is the descriptor-tier sweet spot; the
// others (streaming/multi-turn/tool-use) need chat/tools blocks the simple form can't author,
// so for those the user is steered to the raw-JSON escape hatch.
const ALL_CAPS: Capability[] = ["batch-tasks", "streaming", "multi-turn", "tool-use"];

// Split a whitespace/newline-separated token string into an args array (preserving {prompt}).
function splitTokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Build a manifest JSON object from the form. Mirrors the descriptor schema in adapter.rs:
// the seven pipeline task names all share the one args template (as the bundled plugins do),
// so a single CLI invocation shape powers cleanup/synthesis/diff. Only blocks for ticked
// capabilities are emitted (orthogonality). The result is pretty-printed for the editor.
function buildManifestFromForm(f: PluginForm): string {
  const caps = f.capabilities.length ? f.capabilities : ["batch-tasks"];
  const manifest: Record<string, unknown> = {
    manifest_version: 1,
    id: f.id.trim(),
    name: f.name.trim() || f.id.trim(),
    version: f.version.trim() || "1.0",
    vendor: f.vendor.trim(),
    command: f.command.trim(),
    capabilities: caps,
    probe: { args: splitTokens(f.probeArgs), expect_exit_code: 0 },
    auth: { type: "session", env: [], note: "" },
  };
  if (caps.includes("batch-tasks")) {
    const args = splitTokens(f.args);
    const taskNames = [
      "ping",
      "transcript-cleanup",
      "cycle-synthesis",
      "cycle-synthesis-extract",
      "cycle-synthesis-reduce",
      "glossary-extract",
      "cycle-diff",
    ];
    manifest.io = {
      payload_via: "stdin",
      prompt_via: "arg",
      result_extract: { format: "json", json_path: f.resultPath.trim() || "result" },
      timeout_sec: 600,
      max_stdin_bytes: 10000000,
    };
    manifest.tasks = Object.fromEntries(
      taskNames.map((t) => [t, { args_template: args }]),
    );
  }
  // Optional models block: one "id label words…" per line.
  const modelLines = f.models
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (modelLines.length) {
    manifest.models = {
      available: modelLines.map((line) => {
        const [id, ...rest] = line.split(/\s+/);
        return rest.length ? { id, label: rest.join(" ") } : { id };
      }),
    };
  }
  return JSON.stringify(manifest, null, 2);
}

// The "Add a CLI plugin" dialog. Three modes: a descriptor-level FORM that builds the
// manifest for the common batch-tasks CLI, a raw-JSON escape hatch (pre-filled from the form,
// for advanced chat/tool-use tiers), and the read-only agent Guide + Schema. Form/JSON write
// via save_plugin_manifest; Test CLI reuses the probe once the plugin is saved.
function AddAdapterDialog() {
  const { data: meta, isPending: metaPending } = useAdapterMeta();
  const { data: schema, isPending: schemaPending } = usePluginManifestSchema();
  const save = useSavePluginManifest();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PluginForm>(EMPTY_PLUGIN_FORM);
  // The raw-JSON editor buffer. Kept separate so the user's hand-edits survive; it's
  // (re)seeded from the form when the user switches to the JSON tab via "Собрать из формы".
  const [rawJson, setRawJson] = useState<string>("");
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const set = <K extends keyof PluginForm>(k: K, v: PluginForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const toggleCap = (c: Capability) =>
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(c)
        ? f.capabilities.filter((x) => x !== c)
        : [...f.capabilities, c],
    }));

  // Reset everything when the dialog closes (so re-opening starts clean).
  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setForm(EMPTY_PLUGIN_FORM);
      setRawJson("");
      setProbe(null);
    }
  }

  // Save the manifest (from the active editor). `source` picks form vs raw JSON.
  async function handleSave(source: "form" | "raw") {
    const id = form.id.trim();
    if (!id) {
      toast.error("Укажите id плагина");
      return;
    }
    const manifestJson = source === "raw" ? rawJson : buildManifestFromForm(form);
    try {
      await save.mutateAsync({ id, manifestJson });
      toast.success("Плагин сохранён");
    } catch (e) {
      toast.error(`Не удалось сохранить. ${String(e)}`);
    }
  }

  // Test CLI: saves the current manifest first (the probe resolves the plugin by id from
  // disk), then runs the probe. Surfaces a clear status badge inline.
  async function handleTest() {
    const id = form.id.trim();
    if (!id) {
      toast.error("Укажите id плагина");
      return;
    }
    try {
      const manifestJson = rawJson.trim() ? rawJson : buildManifestFromForm(form);
      await save.mutateAsync({ id, manifestJson });
      const r = await testCli(id);
      setProbe(r);
    } catch (e) {
      toast.error(`Не удалось протестировать. ${String(e)}`);
    }
  }

  const badge = probe ? probeBadge(probe.status) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-3.5" />
          Добавить плагин…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Добавить CLI-плагин</DialogTitle>
          <DialogDescription>
            Плагин — это папка{" "}
            <code className="font-numeric text-[11px]">plugins/&lt;id&gt;/manifest.json</code>.
            Заполните форму ниже, чтобы создать её прямо из приложения, либо отдайте
            гайд («Для агента») локальному ИИ-агенту.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="form" className="min-h-0 gap-3 overflow-hidden">
          <TabsList variant="line" className="border-b border-border pb-0">
            <TabsTrigger value="form">Форма</TabsTrigger>
            <TabsTrigger value="raw">Сырой JSON</TabsTrigger>
            <TabsTrigger value="agent">Для агента</TabsTrigger>
          </TabsList>

          {/* --- Descriptor-level form --- */}
          <TabsContent
            value="form"
            className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1"
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="id (= имя папки)">
                <Input
                  value={form.id}
                  onChange={(e) => set("id", e.target.value)}
                  placeholder="my-cli"
                />
              </Field>
              <Field label="Название">
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="My CLI"
                />
              </Field>
              <Field label="Команда (бинарь на PATH)">
                <Input
                  value={form.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="mycli"
                />
              </Field>
              <Field label="Вендор (опц.)">
                <Input
                  value={form.vendor}
                  onChange={(e) => set("vendor", e.target.value)}
                  placeholder="Acme"
                />
              </Field>
              <Field label="Версия (опц.)">
                <Input
                  value={form.version}
                  onChange={(e) => set("version", e.target.value)}
                  placeholder="1.0"
                />
              </Field>
              <Field label="Probe-команда (после бинаря)">
                <Input
                  value={form.probeArgs}
                  onChange={(e) => set("probeArgs", e.target.value)}
                  placeholder="--version"
                />
              </Field>
            </div>

            <Field label="Аргументы задачи (с плейсхолдером {prompt})">
              <Input
                value={form.args}
                onChange={(e) => set("args", e.target.value)}
                placeholder="-p {prompt} --output-format json"
                className="font-numeric text-xs"
              />
            </Field>

            <Field label="Поле JSON-конверта с результатом (result_extract.json_path)">
              <Input
                value={form.resultPath}
                onChange={(e) => set("resultPath", e.target.value)}
                placeholder="result"
                className="w-40 font-numeric text-xs"
              />
            </Field>

            <Field label="Возможности">
              <div className="flex flex-wrap gap-3">
                {ALL_CAPS.map((c) => (
                  <label
                    key={c}
                    className="flex items-center gap-1.5 text-xs text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={form.capabilities.includes(c)}
                      onChange={() => toggleCap(c)}
                      className="size-3.5 accent-primary"
                    />
                    {CAPABILITY_LABELS[c]}
                  </label>
                ))}
              </div>
              {form.capabilities.some((c) => c !== "batch-tasks") && (
                <span className="text-[11px] text-status-importing">
                  Для streaming / multi-turn / tool-use заполните блоки chat/tools во
                  вкладке «Сырой JSON».
                </span>
              )}
            </Field>

            <Field label="Модели (опц., по одной в строке: «id подпись»)">
              <Textarea
                value={form.models}
                onChange={(e) => set("models", e.target.value)}
                placeholder={"haiku Haiku (fast)\nsonnet Sonnet (balanced)"}
                className="h-20 font-numeric text-xs"
              />
            </Field>

            <DialogActions
              badge={badge}
              probe={probe}
              pending={save.isPending}
              onTest={handleTest}
              onSave={() => handleSave("form")}
            />
          </TabsContent>

          {/* --- Raw JSON escape hatch --- */}
          <TabsContent
            value="raw"
            className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Полный манифест. Для продвинутых тиров (chat / adapter-program).
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRawJson(buildManifestFromForm(form))}
              >
                Собрать из формы
              </Button>
            </div>
            <Textarea
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              placeholder='{ "id": "my-cli", … }'
              className="h-72 font-numeric text-[11px]"
            />
            <DialogActions
              badge={badge}
              probe={probe}
              pending={save.isPending}
              onTest={handleTest}
              onSave={() => handleSave("raw")}
            />
          </TabsContent>

          {/* --- Read-only agent guide + schema --- */}
          <TabsContent
            value="agent"
            className="max-h-[62vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-4"
          >
            <p className="mb-3 text-[11px] text-muted-foreground">
              Отдайте этот гайд локальному ИИ-агенту (например, Claude Code), чтобы он
              сам собрал плагин и положил папку в{" "}
              <code className="font-numeric">plugins/</code>, затем нажмите «Rescan
              plugins».
            </p>
            {metaPending || !meta ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <pre className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/90">
                {meta}
              </pre>
            )}
            <div className="mt-4 border-t border-border pt-3">
              <span className="text-xs font-medium text-foreground">
                Схема манифеста
              </span>
              {schemaPending || !schema ? (
                <Skeleton className="mt-2 h-48 w-full" />
              ) : (
                <pre className="mt-2 whitespace-pre-wrap font-numeric text-[11px] leading-relaxed text-foreground/90">
                  {schema}
                </pre>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// A labelled form field (label above the control).
function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// The shared Test CLI / Save action row (with the inline probe badge) used by both editors.
function DialogActions({
  badge,
  probe,
  pending,
  onTest,
  onSave,
}: {
  badge: { variant: "default" | "secondary" | "outline" | "destructive"; icon: ReactNode; label: string } | null;
  probe: ProbeResult | null;
  pending: boolean;
  onTest: () => void;
  onSave: () => void;
}) {
  return (
    <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-background pt-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onTest} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <TerminalSquare className="size-3.5" />
          )}
          Test CLI
        </Button>
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Сохранить
        </Button>
        {badge && (
          <Badge variant={badge.variant}>
            {badge.icon}
            {badge.label}
          </Badge>
        )}
      </div>
      {probe && (
        <span className="text-[11px] text-muted-foreground">
          {probe.detail}
          {probe.version ? ` (${probe.version})` : ""}
        </span>
      )}
    </div>
  );
}

// One task-model row (Cleanup / Synthesis / Diff): a Select seeded from the saved override,
// whose options are a leading "Plugin default" (value "") plus the active plugin's models.
// On change → persist the override + invalidate so the seed refreshes.
function TaskModelRow({
  bucket,
  label,
  models,
}: {
  bucket: TaskModelBucket;
  label: string;
  models: ModelOption[];
}) {
  const qc = useQueryClient();
  const { data: saved } = useTaskModel(bucket);
  const save = useMutation({
    mutationFn: (model: string) => setTaskModel(bucket, model),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: adapterKeys.taskModel(bucket) }),
    onError: (e) => toast.error(`Couldn't save model. ${String(e)}`),
  });
  // "" is the "Plugin default" sentinel; Radix Select can't use "" as an item value, so the
  // default option carries a stable sentinel that maps back to "" on save.
  const DEFAULT = "__default__";
  const value = saved ? saved : DEFAULT;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-foreground">{label}</span>
      <Select
        value={value}
        onValueChange={(v) => save.mutate(v === DEFAULT ? "" : v)}
      >
        <SelectTrigger className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>Plugin default</SelectItem>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.label || m.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// The "Task models" section: lets the user pick which of the ACTIVE plugin's models runs
// each task bucket. Shown only when the active plugin offers models; otherwise a muted note
// (the CLI's built-in model is used and there's nothing to pick).
function TaskModelsSection({ active }: { active?: AdapterSummary }) {
  const models = active?.models ?? [];
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">Task models</span>
        <span className="text-xs text-muted-foreground">
          Which of {active ? active.name : "the active plugin"}’s models runs each
          task. “Plugin default” uses the plugin’s own per-task choice.
        </span>
      </div>
      {models.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          This CLI uses its built-in model.
        </span>
      ) : (
        <div className="flex max-w-md flex-col gap-3">
          <TaskModelRow bucket="cleanup" label="Cleanup" models={models} />
          <TaskModelRow bucket="synthesis" label="Synthesis" models={models} />
          <TaskModelRow bucket="diff" label="Diff" models={models} />
        </div>
      )}
    </div>
  );
}

function AiCliTab() {
  const { data: adapters, isPending: adaptersPending } = useAdapters();
  const { data: activeId } = useActiveAdapter();
  const qc = useQueryClient();

  // Test CLI probe result (UI-local; runs the real CLI under Tauri).
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  // Only valid (ok) plugins can be active / selected. Malformed manifests are listed
  // in the grid below but excluded from the selector + the default-active fallback.
  const okAdapters = adapters?.filter((a) => a.ok) ?? [];
  const effectiveActiveId = activeId ?? okAdapters[0]?.id;

  const setActive = useMutation({
    mutationFn: (id: string) => setActiveAdapter(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.active }),
  });

  const runProbe = useMutation({
    mutationFn: (id?: string) => testCli(id),
    onSuccess: (r) => {
      setProbe(r);
      if (r.status === "available") toast.success("CLI is available");
      else if (r.status === "not-found") toast.error("CLI not found on PATH");
      else if (r.status === "not-logged-in")
        toast.warning("CLI installed, but not logged in");
      else toast.error("CLI probe failed");
    },
    onError: (e) => toast.error(`Test failed. ${String(e)}`),
  });

  const rescan = useMutation({
    mutationFn: () => rescanPlugins(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adapterKeys.list });
      toast.success("Rescanned plugins");
    },
    onError: (e) => toast.error(`Rescan failed. ${String(e)}`),
  });

  const badge = probe ? probeBadge(probe.status) : null;

  return (
    <div className="flex w-full flex-col gap-7 pt-2">
      {/* Active plugin + Test CLI + Rescan */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">Active plugin</span>
          <span className="text-xs text-muted-foreground">
            The local CLI InterviewLab uses for cleanup, synthesis, and diff. Claude
            Code uses your <code className="font-numeric text-[11px]">claude login</code>{" "}
            session — no API key needed.
          </span>
        </div>

        {adaptersPending || !adapters ? (
          <Skeleton className="h-8 w-full max-w-xs" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={effectiveActiveId}
              onValueChange={(id) => setActive.mutate(id)}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Select a plugin" />
              </SelectTrigger>
              <SelectContent>
                {okAdapters.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              onClick={() => runProbe.mutate(effectiveActiveId ?? undefined)}
              disabled={runProbe.isPending}
            >
              {runProbe.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <TerminalSquare className="size-3.5" />
              )}
              Test CLI
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
            >
              {rescan.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Rescan plugins
            </Button>

            {badge && (
              <Badge variant={badge.variant}>
                {badge.icon}
                {badge.label}
              </Badge>
            )}
          </div>
        )}

        {probe && (
          <span className="max-w-xl text-xs text-muted-foreground">
            {probe.detail}
            {probe.version ? ` (${probe.version})` : ""}
          </span>
        )}
      </div>

      {/* Task models (only meaningful once the active plugin is known) */}
      {!adaptersPending && adapters && (
        <TaskModelsSection
          active={okAdapters.find((a) => a.id === effectiveActiveId)}
        />
      )}

      {/* Installed plugins */}
      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-foreground">
              Installed plugins
            </span>
            <span className="text-xs text-muted-foreground">
              The bundled Claude Code default, plus any you add.
            </span>
          </div>
          <AddAdapterDialog />
        </div>

        {adaptersPending || !adapters ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {adapters.map((a) => (
              <AdapterCard
                key={a.id}
                adapter={a}
                active={a.ok && a.id === effectiveActiveId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
          Settings
        </h1>
        <p className="text-xs text-muted-foreground">
          Local CLI adapters, transcription, and app info.
        </p>
      </header>

      <Tabs defaultValue="ai-cli" className="gap-5">
        <TabsList variant="line" className="border-b border-border pb-0">
          <TabsTrigger value="ai-cli">AI CLI</TabsTrigger>
          <TabsTrigger value="transcription">Transcription</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="ai-cli">
          <AiCliTab />
        </TabsContent>

        <TabsContent value="transcription">
          <TranscriptionTab />
        </TabsContent>

        <TabsContent value="roles">
          <RolesSettings />
        </TabsContent>

        <TabsContent value="about">
          <div className="flex w-full flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-medium text-foreground">
                About InterviewLab
              </h2>
              <p className="text-xs text-muted-foreground">
                A local-first interview research workspace.
              </p>
            </div>
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between border-b border-border py-2">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-numeric text-foreground/80">0.1.0</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">Build</dt>
                <dd className="font-numeric text-foreground/80">local-dev</dd>
              </div>
            </dl>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
