import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
  type ModelInfo,
  type ModelProgress,
} from "@/lib/tauri";
import { mockOnDiarModelProgress, mockOnModelProgress } from "@/lib/dev-mock";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useT, tr } from "@/lib/i18n";

const STR = {
  ru: {
    welcomeIntro:
      "InterviewLab — локальная мастерская для исследовательских интервью. Транскрипция, разметка спикеров и работа с ИИ выполняются на вашей машине.",
    welcomeDesc:
      "Этот короткий мастер за минуту доведёт приложение до рабочего состояния: проверим устройство, скачаем модель распознавания и подключим локальный ИИ-CLI. Любой шаг можно пропустить и настроить позже в «Настройках».",
    speed: {
      fastest: "очень быстрая",
      fast: "быстрая",
      medium: "средняя",
      slow: "медленная",
      slowest: "самая медленная",
    } as Record<ModelInfo["speed"], string>,
    accuracy: {
      lowest: "низкая",
      basic: "базовая",
      good: "хорошая",
      high: "высокая",
      highest: "максимальная",
    } as Record<ModelInfo["accuracy"], string>,
    sizeGb: (n: string) => `${n} ГБ`,
    sizeMb: (n: number) => `${n} МБ`,
    deviceHint:
      "Whisper использует GPU, когда доступны сборка с CUDA и видеокарта Nvidia, иначе работает на CPU.",
    cpu: "CPU",
    gpuActive: (engine: string) => `GPU активен (${engine})`,
    appleMetal: "Apple Metal",
    multilingualBadge: "🌍 Многоязычная",
    englishOnly: "Только английский",
    speedLabel: (v: string) => `Скорость: ${v}`,
    accuracyLabel: (v: string) => `Точность: ${v}`,
    modelHint:
      "large-v3 — самая точная (лучше всего для русского). На слабых машинах или CPU выберите base / medium — они быстрее и легче.",
    cpuRecommend:
      "Устройство работает на CPU — для быстрого старта рекомендуем base или medium.",
    selectModel: "Выберите модель",
    multilingualShort: "🌍 многоязычная",
    en: "EN",
    downloaded: "Скачана",
    downloadModel: "Скачать модель",
    downloading: (pct: number) => `Скачивание… ${pct}%`,
    modelDownloadFailed: (err: string) => `Не удалось скачать модель: ${err}`,
    modelDownloaded: "Модель скачана",
    downloadStartFailed: (err: string) =>
      `Не удалось запустить скачивание. ${err}`,
    diarHint:
      "Диаризация размечает, кто говорил в каждом сегменте (S1, S2, …) локально. Нужны отдельные файлы моделей. Этот шаг можно пропустить — включить позже в «Настройках».",
    diarInstalled: "Модели установлены",
    diarNotDownloaded: "Не скачаны",
    diarDownload: "Скачать модели спикеров",
    diarStartLabel: "Запуск…",
    diarDownloadFailed: (err: string) =>
      `Не удалось скачать модель диаризации: ${err}`,
    diarDownloaded: "Модели диаризации скачаны",
    cliHintBefore: "Локальный ИИ-CLI выполняет очистку, синтез и сравнение версий. Claude Code использует вашу сессию ",
    cliHintAfter: " — ключ API не нужен.",
    pluginNotSelected: "Плагин не выбран",
    rescan: "Пересканировать",
    rescanned: "Плагины пересканированы",
    rescanFailed: (err: string) => `Пересканирование не удалось. ${err}`,
    noPlugins:
      "Плагины не найдены. Установите локальный ИИ-CLI (например, Claude Code), затем нажмите «Пересканировать». Добавить свой плагин можно в «Настройках» → «AI CLI».",
    activePlugin: "Активный плагин: ",
    doneIntro:
      "Готово — приложение настроено. Создайте цикл, импортируйте запись интервью и запустите транскрипцию.",
    doneDesc:
      "Всё, что здесь настроено, всегда доступно в «Настройках» — можно поменять модель, включить диаризацию или сменить ИИ-CLI в любой момент.",
    meta: {
      welcome: { title: "Добро пожаловать в InterviewLab", description: "Настройка за минуту" },
      device: { title: "Устройство", description: "На чём будет работать распознавание" },
      model: { title: "Модель распознавания", description: "Скачайте модель Whisper" },
      diarization: { title: "Диаризация (опционально)", description: "Разметка спикеров" },
      cli: { title: "Подключение ИИ-CLI", description: "Локальный движок для задач с ИИ" },
      done: { title: "Всё готово", description: "Можно начинать работу" },
    } as Record<Step, { title: string; description: string }>,
    setupLater: "Настроить позже",
    back: "Назад",
    finishStart: "Начать работу",
    next: "Далее",
  },
  en: {
    welcomeIntro:
      "InterviewLab is a local workbench for research interviews. Transcription, speaker labeling, and AI work all run on your machine.",
    welcomeDesc:
      "This short wizard gets the app working in a minute: we'll check your device, download a recognition model, and connect a local AI CLI. You can skip any step and set it up later in Settings.",
    speed: {
      fastest: "fastest",
      fast: "fast",
      medium: "medium",
      slow: "slow",
      slowest: "slowest",
    } as Record<ModelInfo["speed"], string>,
    accuracy: {
      lowest: "lowest",
      basic: "basic",
      good: "good",
      high: "high",
      highest: "highest",
    } as Record<ModelInfo["accuracy"], string>,
    sizeGb: (n: string) => `${n} GB`,
    sizeMb: (n: number) => `${n} MB`,
    deviceHint:
      "Whisper uses the GPU when a CUDA build and an Nvidia card are available; otherwise it runs on the CPU.",
    cpu: "CPU",
    gpuActive: (engine: string) => `GPU active (${engine})`,
    appleMetal: "Apple Metal",
    multilingualBadge: "🌍 Multilingual",
    englishOnly: "English only",
    speedLabel: (v: string) => `Speed: ${v}`,
    accuracyLabel: (v: string) => `Accuracy: ${v}`,
    modelHint:
      "large-v3 is the most accurate (best for Russian). On weaker machines or CPU, choose base / medium — they're faster and lighter.",
    cpuRecommend:
      "Your device runs on the CPU — for a quick start we recommend base or medium.",
    selectModel: "Select a model",
    multilingualShort: "🌍 multilingual",
    en: "EN",
    downloaded: "Downloaded",
    downloadModel: "Download model",
    downloading: (pct: number) => `Downloading… ${pct}%`,
    modelDownloadFailed: (err: string) => `Failed to download the model: ${err}`,
    modelDownloaded: "Model downloaded",
    downloadStartFailed: (err: string) =>
      `Failed to start the download. ${err}`,
    diarHint:
      "Diarization labels who spoke in each segment (S1, S2, …) locally. It needs separate model files. You can skip this step and enable it later in Settings.",
    diarInstalled: "Models installed",
    diarNotDownloaded: "Not downloaded",
    diarDownload: "Download speaker models",
    diarStartLabel: "Starting…",
    diarDownloadFailed: (err: string) =>
      `Failed to download the diarization model: ${err}`,
    diarDownloaded: "Diarization models downloaded",
    cliHintBefore: "A local AI CLI handles cleanup, synthesis, and version comparison. Claude Code uses your ",
    cliHintAfter: " session — no API key needed.",
    pluginNotSelected: "No plugin selected",
    rescan: "Rescan",
    rescanned: "Plugins rescanned",
    rescanFailed: (err: string) => `Rescan failed. ${err}`,
    noPlugins:
      "No plugins found. Install a local AI CLI (e.g. Claude Code), then click “Rescan”. You can add your own plugin in Settings → AI CLI.",
    activePlugin: "Active plugin: ",
    doneIntro:
      "Done — the app is set up. Create a cycle, import an interview recording, and start transcription.",
    doneDesc:
      "Everything set up here is always available in Settings — you can change the model, enable diarization, or switch the AI CLI at any time.",
    meta: {
      welcome: { title: "Welcome to InterviewLab", description: "Set up in a minute" },
      device: { title: "Device", description: "Where recognition will run" },
      model: { title: "Recognition model", description: "Download a Whisper model" },
      diarization: { title: "Diarization (optional)", description: "Speaker labeling" },
      cli: { title: "Connect an AI CLI", description: "Local engine for AI tasks" },
      done: { title: "All set", description: "You're ready to start" },
    } as Record<Step, { title: string; description: string }>,
    setupLater: "Set up later",
    back: "Back",
    finishStart: "Start working",
    next: "Next",
  },
};

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
  const t = useT(STR);
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <Sparkles className="size-5" />
      </div>
      <p className="text-sm leading-relaxed text-foreground">
        {t.welcomeIntro}
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t.welcomeDesc}
      </p>
    </div>
  );
}

function formatSize(approxMb: number): string {
  const t = tr(STR);
  return approxMb >= 1000
    ? t.sizeGb((approxMb / 1000).toFixed(1))
    : t.sizeMb(approxMb);
}

function DeviceStep() {
  const t = useT(STR);
  const { data: device, isPending } = useAsrDevice();
  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        {t.deviceHint}
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
                : t.cpu}
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
  );
}

// Characteristics card for the selected model: size, language, quantization, speed,
// accuracy (RU tiers) + the human note. Compact, shadcn Badge styling.
function ModelSpecCard({ model }: { model: ModelInfo }) {
  const t = useT(STR);
  return (
    <div className="flex max-w-md flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{formatSize(model.approx_mb)}</Badge>
        <Badge variant="secondary">
          {model.multilingual ? t.multilingualBadge : t.englishOnly}
        </Badge>
        {model.quantized && <Badge variant="secondary">q5_0</Badge>}
        <Badge variant="outline">{t.speedLabel(t.speed[model.speed])}</Badge>
        <Badge variant="outline">{t.accuracyLabel(t.accuracy[model.accuracy])}</Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{model.note}</p>
    </div>
  );
}

function ModelStep() {
  const t = useT(STR);
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
        toast.error(tr(STR).modelDownloadFailed(p.error));
        setDl(null);
        return;
      }
      if (p.done) {
        setDl(null);
        qc.invalidateQueries({ queryKey: asrKeys.models });
        toast.success(tr(STR).modelDownloaded);
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
      toast.error(t.downloadStartFailed(String(e)));
      setDl(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        {t.modelHint}
      </p>
      {!device?.use_gpu && (
        <p className="text-xs text-status-importing">
          {t.cpuRecommend}
        </p>
      )}

      {isPending || !models ? (
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
                        {m.multilingual ? t.multilingualShort : t.en}
                        {m.quantized ? " · q5_0" : ""}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selected?.downloaded ? (
              <Badge variant="outline">
                <CheckCircle2 className="size-3" />
                {t.downloaded}
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
  );
}

function DiarizationStep() {
  const t = useT(STR);
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
        toast.error(tr(STR).diarDownloadFailed(p.error));
        setDiarDl(null);
        return;
      }
      if (p.done) {
        setDiarDl(null);
        qc.invalidateQueries({ queryKey: asrKeys.diarPresent });
        toast.success(tr(STR).diarDownloaded);
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
    setDiarDl({ step: 0, total_steps: 1, label: t.diarStartLabel, done: false, error: null });
    try {
      await downloadDiarizationModels();
    } catch (e) {
      toast.error(t.downloadStartFailed(String(e)));
      setDiarDl(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        {t.diarHint}
      </p>

      <div className="flex flex-col gap-3">
        {isPending ? (
          <Skeleton className="h-5 w-44" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {present ? (
              <Badge variant="outline">
                <CheckCircle2 className="size-3" />
                {t.diarInstalled}
              </Badge>
            ) : (
              <Badge variant="secondary">
                <AlertCircle className="size-3" />
                {t.diarNotDownloaded}
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
                {t.diarDownload}
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
  const t = useT(STR);
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
      toast.success(tr(STR).rescanned);
    },
    onError: (e) => toast.error(tr(STR).rescanFailed(String(e))),
  });

  return (
    <div className="flex flex-col gap-3 pt-1">
      <p className="text-sm text-muted-foreground">
        {t.cliHintBefore}
        <code className="font-numeric text-[11px]">claude login</code>
        {t.cliHintAfter}
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
                <SelectValue placeholder={t.pluginNotSelected} />
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
              {t.rescan}
            </Button>
          </div>

          {okAdapters.length === 0 ? (
            <p className="text-xs text-status-importing">
              {t.noPlugins}
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <TerminalSquare className="size-3.5" />
              {t.activePlugin}
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
  const t = useT(STR);
  return (
    <div className="flex flex-col gap-3 pt-1">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
        <CheckCircle2 className="size-5" />
      </div>
      <p className="text-sm leading-relaxed text-foreground">
        {t.doneIntro}
      </p>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {t.doneDesc}
      </p>
    </div>
  );
}

// --- Shell --------------------------------------------------------------------

export function OnboardingWizard() {
  const t = useT(STR);
  // Gate on a single localStorage flag — show the wizard until it's marked done.
  const [open, setOpen] = useState(
    () => typeof window !== "undefined" && !localStorage.getItem(ONBOARDED_KEY),
  );
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];
  const meta = t.meta[step];
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
              {t.setupLater}
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
                {t.back}
              </Button>
            )}
            <Button size="sm" onClick={next}>
              {isLast ? (
                t.finishStart
              ) : (
                <>
                  {t.next}
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
