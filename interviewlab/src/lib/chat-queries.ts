import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createChatThread,
  deleteChatThread,
  getChatMessages,
  listChatThreads,
  renameChatThread,
  type ChatMessage,
  type ChatThread,
} from "@/lib/tauri";

// Query keys for the cycle's chat threads + a thread's message history (M11 Phase A).
// Mirrors the synthesis-queries pattern.
export const chatKeys = {
  threads: (cycleId: string) => ["chat-threads", cycleId] as const,
  messages: (threadId: string) => ["chat-messages", threadId] as const,
};

// The cycle's chat threads (newest-active first; the backend orders by updated_at DESC).
export function useChatThreads(cycleId: string | undefined) {
  return useQuery({
    queryKey: chatKeys.threads(cycleId ?? ""),
    queryFn: () => listChatThreads(cycleId as string),
    enabled: !!cycleId,
  });
}

// A thread's persisted messages (the streaming buffer lives in component state).
export function useChatMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: chatKeys.messages(threadId ?? ""),
    queryFn: () => getChatMessages(threadId as string),
    enabled: !!threadId,
  });
}

export function useCreateChatThread(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (title?: string) => createChatThread(cycleId, title),
    onSuccess: (thread: ChatThread) => {
      qc.invalidateQueries({ queryKey: chatKeys.threads(cycleId) });
      qc.setQueryData(chatKeys.messages(thread.id), [] as ChatMessage[]);
    },
  });
}

export function useRenameChatThread(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, title }: { threadId: string; title: string }) =>
      renameChatThread(threadId, title),
    onSuccess: () => qc.invalidateQueries({ queryKey: chatKeys.threads(cycleId) }),
  });
}

export function useDeleteChatThread(cycleId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => deleteChatThread(threadId),
    onSuccess: () => qc.invalidateQueries({ queryKey: chatKeys.threads(cycleId) }),
  });
}
