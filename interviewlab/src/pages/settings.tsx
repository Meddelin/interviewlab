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
  type ModelInfo,
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
import { useT, tr } from "@/lib/i18n";
import { toast } from "sonner";

// §4.4 Settings: Tabs (AI CLI | Transcription | About). M4 fills the Transcription
// tab (device Badge, model Select + Download, language Select); M6 fills the AI CLI
// tab (adapter Cards, active Select, Test CLI probe, Add adapter… dialog).

// Languages the user can force (or auto-detect). Russian-first per spec §6.4.
const LANGUAGE_VALUES = ["auto", "ru", "en"] as const;
const LANGUAGE_LABELS = {
  ru: { auto: "Автоопределение", ru: "Русский", en: "Английский" },
  en: { auto: "Auto-detect", ru: "Russian", en: "English" },
} as const;

// Expected-speaker choices for diarization: "auto" lets it detect the count, else force it.
// The value is the localStorage string; callers map "auto"→null for the backend's
// expectedSpeakers arg.
const EXPECTED_SPEAKER_VALUES = ["auto", "2", "3", "4"] as const;
const EXPECTED_SPEAKER_LABELS = {
  ru: {
    auto: "Автоопределение",
    "2": "2 спикера",
    "3": "3 спикера",
    "4": "4 спикера",
  },
  en: {
    auto: "Auto-detect",
    "2": "2 speakers",
    "3": "3 speakers",
    "4": "4 speakers",
  },
} as const;

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

// Human-readable model characteristics, shared by the picker list + the selected-model
// card. Settings follows the surrounding English copy.
const SPEED_LABEL = {
  ru: {
    fastest: "максимальная",
    fast: "высокая",
    medium: "средняя",
    slow: "низкая",
    slowest: "минимальная",
  },
  en: {
    fastest: "fastest",
    fast: "fast",
    medium: "medium",
    slow: "slow",
    slowest: "slowest",
  },
} as const satisfies Record<"ru" | "en", Record<ModelInfo["speed"], string>>;
const ACCURACY_LABEL = {
  ru: {
    lowest: "минимальная",
    basic: "базовая",
    good: "хорошая",
    high: "высокая",
    highest: "максимальная",
  },
  en: {
    lowest: "lowest",
    basic: "basic",
    good: "good",
    high: "high",
    highest: "highest",
  },
} as const satisfies Record<"ru" | "en", Record<ModelInfo["accuracy"], string>>;

function formatSize(approxMb: number): string {
  return approxMb >= 1000 ? `${(approxMb / 1000).toFixed(1)} GB` : `${approxMb} MB`;
}

const SPEC_CARD_STR = {
  ru: {
    multilingual: "🌍 Многоязычная",
    englishOnly: "Только английский",
    speed: "Скорость",
    accuracy: "Точность",
  },
  en: {
    multilingual: "🌍 Multilingual",
    englishOnly: "English-only",
    speed: "Speed",
    accuracy: "Accuracy",
  },
} as const;

// Characteristics card for the selected model: size, language, quantization, speed,
// accuracy + the human note. Compact, shadcn Badge styling.
function ModelSpecCard({ model }: { model: ModelInfo }) {
  const t = useT(SPEC_CARD_STR);
  const speed = useT(SPEED_LABEL);
  const accuracy = useT(ACCURACY_LABEL);
  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{formatSize(model.approx_mb)}</Badge>
        <Badge variant="secondary">
          {model.multilingual ? t.multilingual : t.englishOnly}
        </Badge>
        {model.quantized && <Badge variant="secondary">q5_0</Badge>}
        <Badge variant="outline">{t.speed}: {speed[model.speed]}</Badge>
        <Badge variant="outline">{t.accuracy}: {accuracy[model.accuracy]}</Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{model.note}</p>
    </div>
  );
}

const TRANSCRIPTION_STR = {
  ru: {
    modelDownloadFailed: (err: string) => `Не удалось скачать модель: ${err}`,
    modelDownloaded: "Модель скачана",
    couldntStart: (err: string) => `Не удалось начать загрузку. ${err}`,
    diarDownloadFailed: (err: string) => `Не удалось скачать модель диаризации: ${err}`,
    diarDownloaded: "Модели диаризации скачаны",
    starting: "Запуск…",
    computeDevice: "Вычислительное устройство",
    computeDeviceHint:
      "Whisper работает на GPU, если есть CUDA-сборка и Nvidia GPU, иначе на CPU.",
    gpuActive: (dev: string) => `GPU активен (${dev})`,
    appleMetal: "Apple Metal",
    model: "Модель",
    modelHint:
      "large-v3 — самая точная (лучшая для русского); turbo/medium жертвуют точностью ради скорости.",
    selectModel: "Выберите модель",
    multilingual: "🌍 многоязычная",
    downloaded: "Скачана",
    downloadModel: "Скачать модель",
    downloading: (pct: number) => `Загрузка… ${pct}%`,
    language: "Язык",
    languageHint: "Задайте язык вручную или дайте Whisper определить его по аудио.",
    autoDetect: "Автоопределение",
    diarization: "Диаризация спикеров",
    diarizationHint:
      "Помечает, кто говорил в каждом сегменте (S1, S2, …) локально. Требует собственные файлы модели, отдельно от модели транскрипции выше.",
    modelsInstalled: "Модели установлены",
    notDownloaded: "Не скачаны",
    downloadDiar: "Скачать модели диаризации",
    expectedSpeakers: "Ожидаемое число спикеров",
  },
  en: {
    modelDownloadFailed: (err: string) => `Model download failed: ${err}`,
    modelDownloaded: "Model downloaded",
    couldntStart: (err: string) => `Couldn't start the download. ${err}`,
    diarDownloadFailed: (err: string) => `Diarization model download failed: ${err}`,
    diarDownloaded: "Diarization models downloaded",
    starting: "Starting…",
    computeDevice: "Compute device",
    computeDeviceHint:
      "Whisper runs on the GPU when a CUDA build + Nvidia GPU are present, else CPU.",
    gpuActive: (dev: string) => `GPU active (${dev})`,
    appleMetal: "Apple Metal",
    model: "Model",
    modelHint:
      "large-v3 is the most accurate (best for Russian); turbo/medium trade some accuracy for speed.",
    selectModel: "Select a model",
    multilingual: "🌍 multilingual",
    downloaded: "Downloaded",
    downloadModel: "Download model",
    downloading: (pct: number) => `Downloading… ${pct}%`,
    language: "Language",
    languageHint: "Force a language, or let Whisper detect it from the audio.",
    autoDetect: "Auto-detect",
    diarization: "Speaker diarization",
    diarizationHint:
      "Labels who spoke each segment (S1, S2, …) locally. Needs its own model files, separate from the transcription model above.",
    modelsInstalled: "Models installed",
    notDownloaded: "Not downloaded",
    downloadDiar: "Download diarization models",
    expectedSpeakers: "Expected speakers",
  },
} as const;

function TranscriptionTab() {
  const t = useT(TRANSCRIPTION_STR);
  const languageLabels = useT(LANGUAGE_LABELS);
  const speakerLabels = useT(EXPECTED_SPEAKER_LABELS);
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
        toast.error(t.modelDownloadFailed(p.error));
        setDl(null);
        return;
      }
      if (p.done) {
        setDl(null);
        // Refresh the catalog so the "Downloaded" badge flips on.
        qc.invalidateQueries({ queryKey: asrKeys.models });
        toast.success(t.modelDownloaded);
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
  }, [qc, t]);

  async function handleDownload() {
    if (!selected) return;
    setDl({ id: selected.id, pct: 0 });
    try {
      await downloadModel(selected.id);
    } catch (e) {
      toast.error(t.couldntStart(String(e)));
      setDl(null);
    }
  }

  // Subscribe to diarization-model download progress (Tauri event, or the dev-mock bus).
  // Step-level (segmentation + embedding files), so we show "label · step/total" not a %.
  useEffect(() => {
    function onDiar(p: DiarModelProgress) {
      if (p.error) {
        toast.error(t.diarDownloadFailed(p.error));
        setDiarDl(null);
        return;
      }
      if (p.done) {
        setDiarDl(null);
        // Refresh presence so the status line flips to "installed".
        qc.invalidateQueries({ queryKey: asrKeys.diarPresent });
        toast.success(t.diarDownloaded);
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
  }, [qc, t]);

  async function handleDownloadDiar() {
    setDiarDl({ step: 0, total_steps: 1, label: t.starting, done: false, error: null });
    try {
      await downloadDiarizationModels();
    } catch (e) {
      toast.error(t.couldntStart(String(e)));
      setDiarDl(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-7 pt-2">
      {/* Device */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{t.computeDevice}</span>
          <span className="text-xs text-muted-foreground">
            {t.computeDeviceHint}
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
                {device.use_gpu
                  ? device.device === "metal"
                    ? "Metal"
                    : "CUDA"
                  : "CPU"}
              </Badge>
              {device.gpu_name && (
                <span className="text-xs text-muted-foreground">
                  {device.gpu_name}
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">{device.detail}</span>
            {device.use_gpu && (
              <span className="flex items-center gap-1 text-xs font-medium text-primary">
                <Zap className="size-3" />
                {t.gpuActive(device.device === "metal" ? t.appleMetal : "CUDA")}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Model */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{t.model}</span>
          <span className="text-xs text-muted-foreground">
            {t.modelHint}
          </span>
        </div>

        {modelsPending || !models ? (
          <Skeleton className="h-8 w-full max-w-xs" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={asrModelId} onValueChange={setAsrModelId}>
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue placeholder={t.selectModel} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <span className="flex items-center gap-2">
                        {m.label}
                        <span className="font-numeric text-[11px] text-muted-foreground">
                          {formatSize(m.approx_mb)}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {m.multilingual ? t.multilingual : "EN"}
                          {m.quantized ? " · q5_0" : ""}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selected?.downloaded ? (
                <Badge variant="outline">{t.downloaded}</Badge>
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
                  {t.downloadModel}
                  {selected ? (
                    <span className="font-numeric text-xs text-muted-foreground">
                      {formatSize(selected.approx_mb)}
                    </span>
                  ) : null}
                </Button>
              )}
            </div>

            {selected && <ModelSpecCard model={selected} />}

            {dl && selected && dl.id === selected.id && (
              <div className="flex max-w-xs flex-col gap-1">
                <Bar pct={dl.pct} />
                <span className="font-numeric text-[11px] text-muted-foreground">
                  {t.downloading(dl.pct)}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Language */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{t.language}</span>
          <span className="text-xs text-muted-foreground">
            {t.languageHint}
          </span>
        </div>
        <Select value={asrLanguage} onValueChange={setAsrLanguage}>
          <SelectTrigger className="w-full max-w-xs">
            <SelectValue placeholder={t.autoDetect} />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_VALUES.map((v) => (
              <SelectItem key={v} value={v}>
                {languageLabels[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Speaker diarization */}
      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {t.diarization}
          </span>
          <span className="text-xs text-muted-foreground">
            {t.diarizationHint}
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
                  {t.modelsInstalled}
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <AlertCircle className="size-3" />
                  {t.notDownloaded}
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
                  {t.downloadDiar}
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
            {t.expectedSpeakers}
          </span>
          <Select value={asrExpectedSpeakers} onValueChange={setAsrExpectedSpeakers}>
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder={t.autoDetect} />
            </SelectTrigger>
            <SelectContent>
              {EXPECTED_SPEAKER_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {speakerLabels[v]}
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

// Probe-status badge labels (the variant/icon stay constant; only the text localizes).
const PROBE_BADGE_STR = {
  ru: {
    available: "Доступен",
    notFound: "Не найден",
    notLoggedIn: "Не выполнен вход",
    error: "Ошибка",
  },
  en: {
    available: "Available",
    notFound: "Not found",
    notLoggedIn: "Not logged in",
    error: "Error",
  },
} as const;

// Map a probe status to its Badge styling + icon + label.
function probeBadge(status: ProbeStatus) {
  const s = tr(PROBE_BADGE_STR);
  switch (status) {
    case "available":
      return {
        variant: "default" as const,
        icon: <CheckCircle2 className="size-3" />,
        label: s.available,
      };
    case "not-found":
      return {
        variant: "secondary" as const,
        icon: <AlertCircle className="size-3" />,
        label: s.notFound,
      };
    case "not-logged-in":
      return {
        variant: "outline" as const,
        icon: <LogIn className="size-3" />,
        label: s.notLoggedIn,
      };
    default:
      return {
        variant: "destructive" as const,
        icon: <AlertCircle className="size-3" />,
        label: s.error,
      };
  }
}

// Human-readable labels for the capability chips (feature-cli-plugins.md §3.1).
const CAPABILITY_LABELS = {
  ru: {
    "batch-tasks": "Пакет",
    streaming: "Стриминг",
    "multi-turn": "Многоходовой",
    "tool-use": "Инструменты",
  },
  en: {
    "batch-tasks": "Batch",
    streaming: "Streaming",
    "multi-turn": "Multi-turn",
    "tool-use": "Tools",
  },
} as const satisfies Record<"ru" | "en", Record<Capability, string>>;

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
const ADAPTER_CARD_STR = {
  ru: {
    testFailed: (err: string) => `Тест не пройден. ${err}`,
    confirmDelete: (name: string, id: string) =>
      `Удалить плагин «${name}»? Папка plugins/${id} будет удалена.`,
    pluginDeleted: "Плагин удалён",
    deleteFailed: (err: string) => `Не удалось удалить. ${err}`,
    unknown: "неизвестно",
    invalid: "Некорректный",
    delete: "Удалить",
    default: "По умолчанию",
    active: "Активен",
    runsExternal: "запускает внешнюю программу",
    testCli: "Проверить CLI",
    deletePlugin: "Удалить плагин",
  },
  en: {
    testFailed: (err: string) => `Test failed. ${err}`,
    confirmDelete: (name: string, id: string) =>
      `Delete plugin "${name}"? The plugins/${id} folder will be removed.`,
    pluginDeleted: "Plugin deleted",
    deleteFailed: (err: string) => `Couldn't delete. ${err}`,
    unknown: "unknown",
    invalid: "Invalid",
    delete: "Delete",
    default: "Default",
    active: "Active",
    runsExternal: "runs external program",
    testCli: "Test CLI",
    deletePlugin: "Delete plugin",
  },
} as const;

function AdapterCard({
  adapter,
  active,
}: {
  adapter: AdapterSummary;
  active: boolean;
}) {
  const t = useT(ADAPTER_CARD_STR);
  const capLabels = useT(CAPABILITY_LABELS);
  // Per-card probe state (each card holds its own result, independent of the global probe).
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const runProbe = useMutation({
    mutationFn: () => testCli(adapter.id),
    onSuccess: (r) => setProbe(r),
    onError: (e) => toast.error(t.testFailed(String(e))),
  });
  const badge = probe ? probeBadge(probe.status) : null;

  // Delete a user (non-builtin) plugin, with a confirm. Builtin plugins show no button.
  const del = useDeletePlugin();
  function handleDelete() {
    if (!window.confirm(t.confirmDelete(adapter.name, adapter.id)))
      return;
    del.mutate(adapter.id, {
      onSuccess: () => toast.success(t.pluginDeleted),
      onError: (e) => toast.error(t.deleteFailed(String(e))),
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
              {adapter.id || t.unknown}
            </CardTitle>
            <Badge variant="destructive">
              <AlertCircle className="size-3" />
              {t.invalid}
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
              {t.delete}
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
            {adapter.builtin && <Badge variant="outline">{t.default}</Badge>}
            {active && <Badge variant="default">{t.active}</Badge>}
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
              {capLabels[c]}
            </span>
          ))}
          {adapter.runs_external_program && (
            <span className="rounded-full border border-status-importing/40 px-2 py-0.5 font-numeric text-[10px] text-status-importing">
              {t.runsExternal}
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
            {t.testCli}
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
              title={t.deletePlugin}
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
const ADD_DIALOG_STR = {
  ru: {
    enterId: "Укажите id плагина",
    pluginSaved: "Плагин сохранён",
    saveFailed: (err: string) => `Не удалось сохранить. ${err}`,
    testFailed: (err: string) => `Не удалось протестировать. ${err}`,
    addPlugin: "Добавить плагин…",
    addCliPlugin: "Добавить CLI-плагин",
    descPre: "Плагин — это папка ",
    descPost:
      ". Заполните форму ниже, чтобы создать её прямо из приложения, либо отдайте гайд («Для агента») локальному ИИ-агенту.",
    tabForm: "Форма",
    tabRaw: "Сырой JSON",
    tabAgent: "Для агента",
    fieldId: "id (= имя папки)",
    fieldName: "Название",
    fieldCommand: "Команда (бинарь на PATH)",
    fieldVendor: "Вендор (опц.)",
    fieldVersion: "Версия (опц.)",
    fieldProbe: "Probe-команда (после бинаря)",
    fieldArgs: "Аргументы задачи (с плейсхолдером {prompt})",
    fieldResultPath: "Поле JSON-конверта с результатом (result_extract.json_path)",
    fieldCaps: "Возможности",
    capsHint:
      "Для streaming / multi-turn / tool-use заполните блоки chat/tools во вкладке «Сырой JSON».",
    fieldModels: "Модели (опц., по одной в строке: «id подпись»)",
    rawHint: "Полный манифест. Для продвинутых тиров (chat / adapter-program).",
    buildFromForm: "Собрать из формы",
    agentHintPre:
      "Отдайте этот гайд локальному ИИ-агенту (например, Claude Code), чтобы он сам собрал плагин и положил папку в ",
    agentHintPost: ", затем нажмите «Пересканировать плагины».",
    manifestSchema: "Схема манифеста",
  },
  en: {
    enterId: "Enter the plugin id",
    pluginSaved: "Plugin saved",
    saveFailed: (err: string) => `Couldn't save. ${err}`,
    testFailed: (err: string) => `Couldn't test. ${err}`,
    addPlugin: "Add a plugin…",
    addCliPlugin: "Add a CLI plugin",
    descPre: "A plugin is a ",
    descPost:
      " folder. Fill in the form below to create it right from the app, or hand the guide (\"For an agent\") to a local AI agent.",
    tabForm: "Form",
    tabRaw: "Raw JSON",
    tabAgent: "For an agent",
    fieldId: "id (= folder name)",
    fieldName: "Name",
    fieldCommand: "Command (binary on PATH)",
    fieldVendor: "Vendor (opt.)",
    fieldVersion: "Version (opt.)",
    fieldProbe: "Probe command (after the binary)",
    fieldArgs: "Task arguments (with the {prompt} placeholder)",
    fieldResultPath: "Result JSON-envelope field (result_extract.json_path)",
    fieldCaps: "Capabilities",
    capsHint:
      "For streaming / multi-turn / tool-use, fill in the chat/tools blocks in the \"Raw JSON\" tab.",
    fieldModels: "Models (opt., one per line: \"id label\")",
    rawHint: "Full manifest. For advanced tiers (chat / adapter-program).",
    buildFromForm: "Build from form",
    agentHintPre:
      "Hand this guide to a local AI agent (e.g. Claude Code) so it builds the plugin and drops the folder into ",
    agentHintPost: ", then click \"Rescan plugins\".",
    manifestSchema: "Manifest schema",
  },
} as const;

function AddAdapterDialog() {
  const t = useT(ADD_DIALOG_STR);
  const capLabels = useT(CAPABILITY_LABELS);
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
      toast.error(t.enterId);
      return;
    }
    const manifestJson = source === "raw" ? rawJson : buildManifestFromForm(form);
    try {
      await save.mutateAsync({ id, manifestJson });
      toast.success(t.pluginSaved);
    } catch (e) {
      toast.error(t.saveFailed(String(e)));
    }
  }

  // Test CLI: saves the current manifest first (the probe resolves the plugin by id from
  // disk), then runs the probe. Surfaces a clear status badge inline.
  async function handleTest() {
    const id = form.id.trim();
    if (!id) {
      toast.error(t.enterId);
      return;
    }
    try {
      const manifestJson = rawJson.trim() ? rawJson : buildManifestFromForm(form);
      await save.mutateAsync({ id, manifestJson });
      const r = await testCli(id);
      setProbe(r);
    } catch (e) {
      toast.error(t.testFailed(String(e)));
    }
  }

  const badge = probe ? probeBadge(probe.status) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-3.5" />
          {t.addPlugin}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.addCliPlugin}</DialogTitle>
          <DialogDescription>
            {t.descPre}
            <code className="font-numeric text-[11px]">plugins/&lt;id&gt;/manifest.json</code>
            {t.descPost}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="form" className="min-h-0 gap-3 overflow-hidden">
          <TabsList variant="line" className="border-b border-border pb-0">
            <TabsTrigger value="form">{t.tabForm}</TabsTrigger>
            <TabsTrigger value="raw">{t.tabRaw}</TabsTrigger>
            <TabsTrigger value="agent">{t.tabAgent}</TabsTrigger>
          </TabsList>

          {/* --- Descriptor-level form --- */}
          <TabsContent
            value="form"
            className="flex max-h-[62vh] flex-col gap-3 overflow-y-auto pr-1"
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label={t.fieldId}>
                <Input
                  value={form.id}
                  onChange={(e) => set("id", e.target.value)}
                  placeholder="my-cli"
                />
              </Field>
              <Field label={t.fieldName}>
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="My CLI"
                />
              </Field>
              <Field label={t.fieldCommand}>
                <Input
                  value={form.command}
                  onChange={(e) => set("command", e.target.value)}
                  placeholder="mycli"
                />
              </Field>
              <Field label={t.fieldVendor}>
                <Input
                  value={form.vendor}
                  onChange={(e) => set("vendor", e.target.value)}
                  placeholder="Acme"
                />
              </Field>
              <Field label={t.fieldVersion}>
                <Input
                  value={form.version}
                  onChange={(e) => set("version", e.target.value)}
                  placeholder="1.0"
                />
              </Field>
              <Field label={t.fieldProbe}>
                <Input
                  value={form.probeArgs}
                  onChange={(e) => set("probeArgs", e.target.value)}
                  placeholder="--version"
                />
              </Field>
            </div>

            <Field label={t.fieldArgs}>
              <Input
                value={form.args}
                onChange={(e) => set("args", e.target.value)}
                placeholder="-p {prompt} --output-format json"
                className="font-numeric text-xs"
              />
            </Field>

            <Field label={t.fieldResultPath}>
              <Input
                value={form.resultPath}
                onChange={(e) => set("resultPath", e.target.value)}
                placeholder="result"
                className="w-40 font-numeric text-xs"
              />
            </Field>

            <Field label={t.fieldCaps}>
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
                    {capLabels[c]}
                  </label>
                ))}
              </div>
              {form.capabilities.some((c) => c !== "batch-tasks") && (
                <span className="text-[11px] text-status-importing">
                  {t.capsHint}
                </span>
              )}
            </Field>

            <Field label={t.fieldModels}>
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
                {t.rawHint}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRawJson(buildManifestFromForm(form))}
              >
                {t.buildFromForm}
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
              {t.agentHintPre}
              <code className="font-numeric">plugins/</code>
              {t.agentHintPost}
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
                {t.manifestSchema}
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

const DIALOG_ACTIONS_STR = {
  ru: { testCli: "Проверить CLI", save: "Сохранить" },
  en: { testCli: "Test CLI", save: "Save" },
} as const;

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
  const t = useT(DIALOG_ACTIONS_STR);
  return (
    <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-background pt-3">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onTest} disabled={pending}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <TerminalSquare className="size-3.5" />
          )}
          {t.testCli}
        </Button>
        <Button size="sm" onClick={onSave} disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t.save}
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

const TASK_MODEL_STR = {
  ru: {
    saveFailed: (err: string) => `Не удалось сохранить модель. ${err}`,
    pluginDefault: "По умолчанию плагина",
  },
  en: {
    saveFailed: (err: string) => `Couldn't save model. ${err}`,
    pluginDefault: "Plugin default",
  },
} as const;

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
  const t = useT(TASK_MODEL_STR);
  const qc = useQueryClient();
  const { data: saved } = useTaskModel(bucket);
  const save = useMutation({
    mutationFn: (model: string) => setTaskModel(bucket, model),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: adapterKeys.taskModel(bucket) }),
    onError: (e) => toast.error(t.saveFailed(String(e))),
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
          <SelectItem value={DEFAULT}>{t.pluginDefault}</SelectItem>
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

const TASK_MODELS_SECTION_STR = {
  ru: {
    title: "Модели задач",
    theActivePlugin: "активного плагина",
    hint: (name: string) =>
      `Какая из моделей «${name}» выполняет каждую задачу. «По умолчанию плагина» использует собственный выбор плагина для каждой задачи.`,
    builtIn: "Этот CLI использует встроенную модель.",
    cleanup: "Очистка",
    synthesis: "Синтез",
    diff: "Сравнение",
  },
  en: {
    title: "Task models",
    theActivePlugin: "the active plugin",
    hint: (name: string) =>
      `Which of ${name}’s models runs each task. “Plugin default” uses the plugin’s own per-task choice.`,
    builtIn: "This CLI uses its built-in model.",
    cleanup: "Cleanup",
    synthesis: "Synthesis",
    diff: "Diff",
  },
} as const;

// The "Task models" section: lets the user pick which of the ACTIVE plugin's models runs
// each task bucket. Shown only when the active plugin offers models; otherwise a muted note
// (the CLI's built-in model is used and there's nothing to pick).
function TaskModelsSection({ active }: { active?: AdapterSummary }) {
  const t = useT(TASK_MODELS_SECTION_STR);
  const models = active?.models ?? [];
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-6">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{t.title}</span>
        <span className="text-xs text-muted-foreground">
          {t.hint(active ? active.name : t.theActivePlugin)}
        </span>
      </div>
      {models.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          {t.builtIn}
        </span>
      ) : (
        <div className="flex max-w-md flex-col gap-3">
          <TaskModelRow bucket="cleanup" label={t.cleanup} models={models} />
          <TaskModelRow bucket="synthesis" label={t.synthesis} models={models} />
          <TaskModelRow bucket="diff" label={t.diff} models={models} />
        </div>
      )}
    </div>
  );
}

const AI_CLI_STR = {
  ru: {
    testFailed: (err: string) => `Тест не пройден. ${err}`,
    cliAvailable: "CLI доступен",
    cliNotFound: "CLI не найден в PATH",
    cliNotLoggedIn: "CLI установлен, но вход не выполнен",
    cliProbeFailed: "Не удалось проверить CLI",
    rescanned: "Плагины пересканированы",
    rescanFailed: (err: string) => `Пересканирование не удалось. ${err}`,
    activePlugin: "Активный плагин",
    activePluginHintPre:
      "Локальный CLI, который InterviewLab использует для очистки, синтеза и сравнения. Claude Code использует вашу сессию ",
    activePluginHintPost: " — ключ API не нужен.",
    selectPlugin: "Выберите плагин",
    testCli: "Проверить CLI",
    rescanPlugins: "Пересканировать плагины",
    installedPlugins: "Установленные плагины",
    installedHint: "Встроенный Claude Code по умолчанию плюс любые добавленные вами.",
  },
  en: {
    testFailed: (err: string) => `Test failed. ${err}`,
    cliAvailable: "CLI is available",
    cliNotFound: "CLI not found on PATH",
    cliNotLoggedIn: "CLI installed, but not logged in",
    cliProbeFailed: "CLI probe failed",
    rescanned: "Rescanned plugins",
    rescanFailed: (err: string) => `Rescan failed. ${err}`,
    activePlugin: "Active plugin",
    activePluginHintPre:
      "The local CLI InterviewLab uses for cleanup, synthesis, and diff. Claude Code uses your ",
    activePluginHintPost: " session — no API key needed.",
    selectPlugin: "Select a plugin",
    testCli: "Test CLI",
    rescanPlugins: "Rescan plugins",
    installedPlugins: "Installed plugins",
    installedHint: "The bundled Claude Code default, plus any you add.",
  },
} as const;

function AiCliTab() {
  const t = useT(AI_CLI_STR);
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
      if (r.status === "available") toast.success(t.cliAvailable);
      else if (r.status === "not-found") toast.error(t.cliNotFound);
      else if (r.status === "not-logged-in")
        toast.warning(t.cliNotLoggedIn);
      else toast.error(t.cliProbeFailed);
    },
    onError: (e) => toast.error(t.testFailed(String(e))),
  });

  const rescan = useMutation({
    mutationFn: () => rescanPlugins(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adapterKeys.list });
      toast.success(t.rescanned);
    },
    onError: (e) => toast.error(t.rescanFailed(String(e))),
  });

  const badge = probe ? probeBadge(probe.status) : null;

  return (
    <div className="flex w-full flex-col gap-7 pt-2">
      {/* Active plugin + Test CLI + Rescan */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{t.activePlugin}</span>
          <span className="text-xs text-muted-foreground">
            {t.activePluginHintPre}
            <code className="font-numeric text-[11px]">claude login</code>
            {t.activePluginHintPost}
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
                <SelectValue placeholder={t.selectPlugin} />
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
              {t.testCli}
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
              {t.rescanPlugins}
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
              {t.installedPlugins}
            </span>
            <span className="text-xs text-muted-foreground">
              {t.installedHint}
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

const SETTINGS_PAGE_STR = {
  ru: {
    title: "Настройки",
    subtitle: "Локальные CLI-адаптеры, транскрипция и сведения о приложении.",
    tabAiCli: "AI CLI",
    tabTranscription: "Транскрипция",
    tabRoles: "Роли",
    tabAbout: "О приложении",
    aboutTitle: "О InterviewLab",
    aboutDesc: "Локальное рабочее пространство для исследования интервью.",
    version: "Версия",
    build: "Сборка",
    localDev: "локальная сборка",
  },
  en: {
    title: "Settings",
    subtitle: "Local CLI adapters, transcription, and app info.",
    tabAiCli: "AI CLI",
    tabTranscription: "Transcription",
    tabRoles: "Roles",
    tabAbout: "About",
    aboutTitle: "About InterviewLab",
    aboutDesc: "A local-first interview research workspace.",
    version: "Version",
    build: "Build",
    localDev: "local-dev",
  },
} as const;

export function SettingsPage() {
  const t = useT(SETTINGS_PAGE_STR);
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">
          {t.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {t.subtitle}
        </p>
      </header>

      <Tabs defaultValue="ai-cli" className="gap-5">
        <TabsList variant="line" className="border-b border-border pb-0">
          <TabsTrigger value="ai-cli">{t.tabAiCli}</TabsTrigger>
          <TabsTrigger value="transcription">{t.tabTranscription}</TabsTrigger>
          <TabsTrigger value="roles">{t.tabRoles}</TabsTrigger>
          <TabsTrigger value="about">{t.tabAbout}</TabsTrigger>
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
                {t.aboutTitle}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t.aboutDesc}
              </p>
            </div>
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex items-center justify-between border-b border-border py-2">
                <dt className="text-muted-foreground">{t.version}</dt>
                <dd className="font-numeric text-foreground/80">0.1.0</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-muted-foreground">{t.build}</dt>
                <dd className="font-numeric text-foreground/80">{t.localDev}</dd>
              </div>
            </dl>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
