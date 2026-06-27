import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isMac } from "@/lib/platform";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { asrKeys, useAsrDevice, useModels } from "@/lib/asr-queries";
import {
  adapterKeys,
  useActiveAdapter,
  useAdapters,
} from "@/lib/adapter-queries";
import { useUiStore } from "@/lib/ui-store";
import {
  DIAR_MODEL_PROGRESS_EVENT,
  diarizationModelsPresent,
  downloadDiarizationModels,
  downloadModel,
  IN_TAURI,
  MODEL_PROGRESS_EVENT,
  rescanPlugins,
  setActiveAdapter,
  type DiarModelProgress,
  type ModelProgress,
} from "@/lib/tauri";
import { mockOnDiarModelProgress, mockOnModelProgress } from "@/lib/dev-mock";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// First-run onboarding wizard (§ v2 "простая установка"): a once-through guide that takes
// a fresh user from zero to a working app in a minute — device check, ASR model download,
// optional diarization, and picking an AI CLI plugin. It REUSES the exact Settings flows
// (same queries / commands / progress events); this is just the guided framing on top.
//
// ponytail: "onboarded" gating is a single localStorage flag, not a new DB column. "Skip"
// and "Set up later" simply flip the flag and close — every step is optional.

const ONBOARDED_KEY = "interviewlab.onboarded";

// Same slim, dependency-free bar the Settings tab uses (no shadcn Progress in the tree).
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

// The ordered step ids. Diarization is optional ("Пропустить"); CLI is the last setup step.
const STEPS = [
  "welcome",
  "device",
  "model",
  "diarization",
  "cli",
  "done",
] as const;
type Step = (typeof STEPS)[number];

// --- Step bodies --------------------------------------------------------------

function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Sparkles className="size-5" />
      </div>
      <p className="text-sm leading-relaxed text-foreground">
        InterviewLab — локальная мастерская для исследовательских интервью.
        Транскрипция, разметка спикеров и работа с ИИ выполняются на вашей
        машине.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Этот короткий мастер за минуту доведёт приложение до рабочего
        состояния: проверим устройство, скачаем модель распознавания и подключим
        локальный ИИ-CLI. Любой шаг можно пропустить и настроить позже в
        «Настройках».
      </p>
    </div>
  );
}

// "Скачать GPU-версию" → open the releases page. openUrl is the Tauri opener plugin;
// in the browser preview the plugin isn't present, so fall back to window.open.
const GPU_RELEASES_URL = "https://github.com/Meddelin/interviewlab/releases";
async function openReleases() {
  try {
    await openUrl(GPU_RELEASES_URL);
  } catch {
    // ponytail: browser preview has no opener plugin — plain window.open is enough.
    window.open(GPU_RELEASES_URL, "_blank");
  }
}

const CUDA_WINGET_CMD = "winget install -e --id Nvidia.CUDA";

function DeviceStep() {
  const { data: device, isPending } = useAsrDevice();
  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        Whisper использует GPU, когда доступны сборка с CUDA и видеокарта Nvidia,
        иначе работает на CPU.
      </p>
      {isPending || !device ? (
        <Skeleton className="h-5 w-44" />
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
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
              GPU активен ({device.device === "metal" ? "Apple Metal" : "CUDA"})
            </span>
          )}
          {device.recommendation === "get_gpu_build" && (
            <GpuBuildCallout gpuName={device.gpu_name} cudaBuild={device.cuda_build} />
          )}
        </div>
      )}
    </div>
  );
}

// Shown when a supported GPU is present but THIS build runs on CPU: offer the GPU
// download + (Windows + CUDA needed) the CUDA Toolkit install command.
function GpuBuildCallout({
  gpuName,
  cudaBuild,
}: {
  gpuName: string | null;
  cudaBuild: boolean;
}) {
  const [copied, setCopied] = useState(false);
  // winget only on Windows, and only when this build needs CUDA (not a Metal build).
  const showWinget = !isMac && !cudaBuild;
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
      <p className="text-xs leading-relaxed text-foreground">
        {gpuName ?? "GPU"} обнаружен, но эта сборка работает на CPU. Установите
        GPU-версию для ускорения распознавания.
      </p>
      <Button size="sm" className="self-start" onClick={openReleases}>
        <Download className="size-3.5" />
        Скачать GPU-версию
      </Button>
      {showWinget && (
        <div className="flex flex-col gap-1.5 pt-0.5">
          <span className="text-xs text-muted-foreground">
            Или установите CUDA Toolkit:
          </span>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {CUDA_WINGET_CMD}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(CUDA_WINGET_CMD);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? (
                <CheckCircle2 className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              Копировать
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ModelStep() {
  const { data: device } = useAsrDevice();
  const { data: models, isPending } = useModels();
  const qc = useQueryClient();

  const asrModelId = useUiStore((s) => s.asrModelId);
  const setAsrModelId = useUiStore((s) => s.setAsrModelId);

  const [dl, setDl] = useState<{ id: string; pct: number } | null>(null);
  const selected = models?.find((m) => m.id === asrModelId);

  // Same progress wiring as the Settings Transcription tab (Tauri event or dev-mock bus).
  useEffect(() => {
    function onProgress(p: ModelProgress) {
      const pct =
        p.total_bytes > 0
          ? Math.round((p.downloaded_bytes / p.total_bytes) * 100)
          : p.done
            ? 100
            : 0;
      if (p.error) {
        toast.error(`Не удалось скачать модель: ${p.error}`);
        setDl(null);
        return;
      }
      if (p.done) {
        setDl(null);
        qc.invalidateQueries({ queryKey: asrKeys.models });
        toast.success("Модель скачана");
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
      toast.error(`Не удалось запустить скачивание. ${String(e)}`);
      setDl(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        large-v3 — самая точная (лучше всего для русского). На слабых машинах или
        CPU выберите base / medium — они быстрее и легче.
      </p>
      {!device?.use_gpu && (
        <p className="text-xs text-status-importing">
          Устройство работает на CPU — для быстрого старта рекомендуем base или
          medium.
        </p>
      )}

      {isPending || !models ? (
        <Skeleton className="h-8 w-full max-w-xs" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={asrModelId} onValueChange={setAsrModelId}>
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Выберите модель" />
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
              <Badge variant="outline">
                <CheckCircle2 className="size-3" />
                Скачана
              </Badge>
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
                Скачать модель
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
                Скачивание… {dl.pct}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DiarizationStep() {
  const qc = useQueryClient();
  const { data: present, isPending } = useQuery({
    queryKey: asrKeys.diarPresent,
    queryFn: diarizationModelsPresent,
  });
  const [diarDl, setDiarDl] = useState<DiarModelProgress | null>(null);

  // Same step-level progress wiring as the Settings Transcription tab.
  useEffect(() => {
    function onDiar(p: DiarModelProgress) {
      if (p.error) {
        toast.error(`Не удалось скачать модель диаризации: ${p.error}`);
        setDiarDl(null);
        return;
      }
      if (p.done) {
        setDiarDl(null);
        qc.invalidateQueries({ queryKey: asrKeys.diarPresent });
        toast.success("Модели диаризации скачаны");
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

  async function handleDownload() {
    setDiarDl({ step: 0, total_steps: 1, label: "Запуск…", done: false, error: null });
    try {
      await downloadDiarizationModels();
    } catch (e) {
      toast.error(`Не удалось запустить скачивание. ${String(e)}`);
      setDiarDl(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        Диаризация размечает, кто говорил в каждом сегменте (S1, S2, …) локально.
        Нужны отдельные файлы моделей. Этот шаг можно пропустить — включить позже
        в «Настройках».
      </p>

      <div className="flex flex-col gap-3">
        {isPending ? (
          <Skeleton className="h-5 w-44" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {present ? (
              <Badge variant="outline">
                <CheckCircle2 className="size-3" />
                Модели установлены
              </Badge>
            ) : (
              <Badge variant="secondary">
                <AlertCircle className="size-3" />
                Не скачаны
              </Badge>
            )}
            {!present && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownload}
                disabled={!!diarDl}
              >
                {diarDl ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                Скачать модели спикеров
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
    </div>
  );
}

function CliStep() {
  const { data: adapters, isPending } = useAdapters();
  const { data: activeId } = useActiveAdapter();
  const qc = useQueryClient();

  // Only valid (ok) plugins are selectable; fall back to the first valid one.
  const okAdapters = adapters?.filter((a) => a.ok) ?? [];
  const effectiveActiveId = activeId ?? okAdapters[0]?.id;

  const setActive = useMutation({
    mutationFn: (id: string) => setActiveAdapter(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: adapterKeys.active }),
  });

  const rescan = useMutation({
    mutationFn: () => rescanPlugins(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adapterKeys.list });
      toast.success("Плагины пересканированы");
    },
    onError: (e) => toast.error(`Пересканирование не удалось. ${String(e)}`),
  });

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        Локальный ИИ-CLI выполняет очистку, синтез и сравнение версий. Claude
        Code использует вашу сессию{" "}
        <code className="font-numeric text-[11px]">claude login</code> — ключ API
        не нужен.
      </p>

      {isPending || !adapters ? (
        <Skeleton className="h-8 w-full max-w-xs" />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={effectiveActiveId}
              onValueChange={(id) => setActive.mutate(id)}
              disabled={okAdapters.length === 0}
            >
              <SelectTrigger className="w-full max-w-xs">
                <SelectValue placeholder="Плагин не выбран" />
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
              onClick={() => rescan.mutate()}
              disabled={rescan.isPending}
            >
              {rescan.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Пересканировать
            </Button>
          </div>

          {okAdapters.length === 0 ? (
            <p className="text-xs text-status-importing">
              Плагины не найдены. Установите локальный ИИ-CLI (например, Claude
              Code), затем нажмите «Пересканировать». Добавить свой плагин можно
              в «Настройках» → «AI CLI».
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TerminalSquare className="size-3.5" />
              Активный плагин:{" "}
              <span className="text-foreground">
                {okAdapters.find((a) => a.id === effectiveActiveId)?.name ??
                  effectiveActiveId}
              </span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DoneStep() {
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <CheckCircle2 className="size-5" />
      </div>
      <p className="text-sm leading-relaxed text-foreground">
        Готово — приложение настроено. Создайте цикл, импортируйте запись
        интервью и запустите транскрипцию.
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Всё, что здесь настроено, всегда доступно в «Настройках» — можно поменять
        модель, включить диаризацию или сменить ИИ-CLI в любой момент.
      </p>
    </div>
  );
}

// --- Shell --------------------------------------------------------------------

const STEP_META: Record<Step, { title: string; description: string }> = {
  welcome: {
    title: "Добро пожаловать в InterviewLab",
    description: "Настройка за минуту",
  },
  device: {
    title: "Устройство",
    description: "На чём будет работать распознавание",
  },
  model: {
    title: "Модель распознавания",
    description: "Скачайте модель Whisper",
  },
  diarization: {
    title: "Диаризация (опционально)",
    description: "Разметка спикеров",
  },
  cli: {
    title: "Подключение ИИ-CLI",
    description: "Локальный движок для задач с ИИ",
  },
  done: {
    title: "Всё готово",
    description: "Можно начинать работу",
  },
};

export function OnboardingWizard() {
  // Gate on a single localStorage flag — show the wizard until it's marked done.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && !localStorage.getItem(ONBOARDED_KEY),
  );
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];
  const meta = STEP_META[step];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  function finish() {
    localStorage.setItem(ONBOARDED_KEY, "1");
    setOpen(false);
  }

  function next() {
    if (isLast) finish();
    else setStepIndex((i) => i + 1);
  }

  return (
    <Dialog
      open={open}
      // Closing via Esc / overlay counts as "set up later" — persist so it stays closed.
      onOpenChange={(o) => {
        if (!o) finish();
        else setOpen(true);
      }}
    >
      <DialogContent className="gap-5 sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          {/* Step dots — quiet progress, accent-filled up to the current step. */}
          <div className="flex items-center gap-1.5 pb-1">
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={
                  i <= stepIndex
                    ? "h-1 w-6 rounded-full bg-primary transition-colors"
                    : "h-1 w-6 rounded-full bg-secondary transition-colors"
                }
              />
            ))}
          </div>
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription>{meta.description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-[9rem]">
          {step === "welcome" && <WelcomeStep />}
          {step === "device" && <DeviceStep />}
          {step === "model" && <ModelStep />}
          {step === "diarization" && <DiarizationStep />}
          {step === "cli" && <CliStep />}
          {step === "done" && <DoneStep />}
        </div>

        <div className="flex items-center justify-between gap-2">
          {/* Always-available escape hatch (per spec): skip the whole wizard. */}
          {!isLast ? (
            <Button variant="ghost" size="sm" onClick={finish}>
              Настроить позже
            </Button>
          ) : (
            <span />
          )}

          <div className="flex items-center gap-2">
            {!isFirst && !isLast && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStepIndex((i) => i - 1)}
              >
                Назад
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {isLast ? (
                "Начать работу"
              ) : (
                <>
                  Далее
                  <ArrowRight className="size-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
