import { useRpc, type PluginButtonContentProps, type PluginClientContext, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { input } from "zod";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { changeSchedule, finishedSchedule, listSchedules, localDateTime, parseLocalDateTime, scheduleLabels, scheduleRetentionMs, type ScheduleCard, type ScheduleTimeline } from "../shared/schedules.js";
import { formatResetCountdown, harnessLabels } from "../shared/accounts.js";
import { Button, type Colors } from "./ui.js";

const dateLabel = (value: string) => new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
const publicError = (error: unknown) => {
  const message = error instanceof Error ? error.message : "", index = message.search(/[가-힣]/);
  return index >= 0 ? message.slice(index).split(" requestType=")[0] : "예약을 처리하지 못했습니다. 연결을 확인하고 다시 시도하세요.";
};
function useSchedules(agentId?: string) {
  const rpc = useRpc(listSchedules);
  return useQuery({ queryKey: ["scheduled-messages", agentId ?? "all"], queryFn: () => rpc(agentId ? { agentId } : {}), refetchInterval: 5000 });
}
function useScheduleChange() {
  const rpc = useRpc(changeSchedule), cache = useQueryClient();
  return useMutation({ mutationFn: (input: input<typeof changeSchedule.input>) => rpc(input),
    onSuccess: () => { void cache.invalidateQueries({ queryKey: ["scheduled-messages"] }); } });
}
function DeleteScheduleModal({ job, colors, close }: { job: ScheduleCard; colors: Colors; close: () => void }) {
  const change = useScheduleChange();
  return <Modal title="예약 기록 삭제" open onOpenChange={open => { if (!open && !change.isPending) close(); }}>
    <Modal.Content>
      <View style={{ gap: 16 }}>
        <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", lineHeight: 24 }}>{job.title}의 예약 기록을 삭제할까요?</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 }}>예약 목록과 채팅의 예약 카드에서 삭제됩니다. 이미 전송된 메시지와 대화는 유지됩니다.</Text>
        {change.error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 21 }}>{publicError(change.error)}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
          <Button colors={colors} disabled={change.isPending} onPress={close}>돌아가기</Button>
          <Button colors={colors} danger icon="Trash2" disabled={change.isPending}
            onPress={() => change.mutate({ action: "delete", id: job.id }, { onSuccess: close })}>{change.isPending ? "삭제 중…" : "삭제"}</Button>
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}
function ScheduleForm({ agentId, colors, close, onOverview }: { agentId: string; colors: Colors; close: () => void; onOverview: () => void }) {
  const query = useSchedules(agentId), change = useScheduleChange();
  const refreshRpc = useRpc(listSchedules), cache = useQueryClient();
  const refresh = useMutation({ mutationFn: () => refreshRpc({ agentId, refresh: true }),
    onSuccess: value => cache.setQueryData(["scheduled-messages", agentId], value) });
  const [message, setMessage] = useState("Continue"), [date, setDate] = useState(""), [time, setTime] = useState("");
  const [initialized, setInitialized] = useState(false), [error, setError] = useState<string | null>(null), [now, setNow] = useState(Date.now());
  const pending = query.data?.jobs.find(j => j.status === "waiting" || j.status === "sending") ?? query.data?.jobs.find(j => j.status === "attention");
  useEffect(() => {
    if (initialized || !query.data || !pending && (query.isFetching || query.data.resetReason === "초기화 시각 조회 중…")) return;
    const at = pending?.waitingFor === "quota" ? query.data.defaultAt : pending?.dueAt ?? query.data.defaultAt;
    if (at) { const parts = localDateTime(at); setDate(parts.date); setTime(parts.time); }
    else { setDate(localDateTime(new Date().toISOString()).date); return; }
    if (pending) setMessage(pending.message);
    setInitialized(true);
  }, [query.data, query.isFetching, initialized, pending]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const dueAt = parseLocalDateTime(date, time), supported = query.data?.supported ?? false;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const inputStyle = { color: colors.foreground, backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 16, minHeight: 48 };
  return <View style={{ gap: 20, width: "100%", maxWidth: 620 }}>
    <View style={{ gap: 5 }}>
      <Text accessibilityRole="header" style={{ fontSize: 20, fontWeight: "600", color: colors.foreground }}>메시지 예약</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 21 }}>지정한 시각 이후, 현재 작업이 끝나면 전송합니다.</Text>
      {query.data?.context && <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{harnessLabels[query.data.context.harness]} · {query.data.context.accountLabel}</Text>}
    </View>
    {query.isPending && <ActivityIndicator color={colors.accent} accessibilityLabel="예약 정보 조회 중" />}
    {query.isError && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{publicError(query.error)}</Text>}
    {query.data && !supported && <Text accessibilityRole="alert" style={{ color: colors.statusWarning, lineHeight: 22 }}>안전한 예약 전송을 위해 Paseo 호스트 업데이트가 필요합니다.</Text>}
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>예약 메시지</Text>
      <TextInput accessibilityLabel="예약 메시지" value={message} onChangeText={setMessage} multiline maxLength={16000}
        editable={!change.isPending && pending?.status !== "sending"} style={{ ...inputStyle, minHeight: 100, textAlignVertical: "top" }} />
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
      <View style={{ flexGrow: 1, flexBasis: 170, gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>날짜</Text>
        <TextInput accessibilityLabel="예약 날짜, 연도-월-일" value={date} onChangeText={value => { setDate(value); setInitialized(true); }} placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.foregroundMuted} maxLength={10} autoCorrect={false} style={inputStyle} />
      </View>
      <View style={{ flexGrow: 1, flexBasis: 150, gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>시간</Text>
        <TextInput accessibilityLabel="예약 시간, 시:분:초" value={time} onChangeText={value => { setTime(value); setInitialized(true); }} placeholder="HH:MM:SS"
          placeholderTextColor={colors.foregroundMuted} maxLength={8} autoCorrect={false} style={inputStyle} />
      </View>
    </View>
    <View style={{ gap: 5 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>기기 시간대 · {timezone}</Text>
      {(dueAt || query.data?.resetReason || query.isPending) && <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 14 }}>{dueAt ? formatResetCountdown(dueAt, now) : query.data?.resetReason ?? "초기화 시각 조회 중…"}</Text>}
      {query.data?.defaultAt && <Pressable accessibilityRole="button" accessibilityLabel="5시간·주간 한도 중 가장 빠른 초기화 시각으로 설정" style={{ minHeight: 44, justifyContent: "center" }}
        onPress={() => { const parts = localDateTime(query.data!.defaultAt!); setDate(parts.date); setTime(parts.time); setInitialized(true); }}>
        <Text style={{ color: colors.accent, fontSize: 14 }}>가장 빠른 초기화 · {dateLabel(query.data.defaultAt)}</Text>
      </Pressable>}
      {query.data?.error && <View style={{ gap: 6 }}>
        <Text accessibilityRole="alert" style={{ color: colors.statusWarning, lineHeight: 21 }}>{query.data.error}</Text>
        {query.data.attemptedAt && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>최근 조회 실패 · {dateLabel(query.data.attemptedAt)}</Text>}
        {query.data.quotaFetchedAt && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>마지막 조회 · {dateLabel(query.data.quotaFetchedAt)}</Text>}
        {query.data.retryAt && Date.parse(query.data.retryAt) > now && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{query.data.retrySource === "server" ? "서버가 지정한 다음 조회 시도" : "다음 조회 시도"} · {dateLabel(query.data.retryAt)} · {formatResetCountdown(query.data.retryAt, now)}</Text>}
        {query.data.retrySource === "server" && <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>서버 제한이 계속되면 대기가 연장될 수 있습니다. 조회 성공 시 초기화 시각이 표시됩니다.</Text>}
        <Button colors={colors} icon="RefreshCw" disabled={refresh.isPending || query.isFetching || !!query.data.retryAt && Date.parse(query.data.retryAt) > now}
          onPress={() => refresh.mutate()}>한도 다시 조회</Button>
      </View>}
      {refresh.error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{publicError(refresh.error)}</Text>}
    </View>
    <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 }}>
      <SettingsSwitch label="사용량 소진 시 자동 재개" hint="이 세션의 현재 계정에서 5시간·주간 한도 중 가장 빠른 초기화 시각에 Continue를 예약합니다."
        value={query.data?.automatic ?? false} disabled={!supported || change.isPending}
        onValueChange={enabled => change.mutate({ action: "automatic", agentId, enabled })} />
    </View>
    {(error || change.error) && <Text accessibilityRole="alert" style={{ color: colors.statusDanger, lineHeight: 21 }}>{error ?? publicError(change.error)}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "space-between" }}>
      <Button colors={colors} icon="List" onPress={onOverview}>예약 목록</Button>
      <Button colors={colors} primary icon="CalendarClock" disabled={!supported || change.isPending || pending?.status === "sending" || !message.trim()}
        onPress={() => { setError(null); if (!dueAt || Date.parse(dueAt) <= Date.now()) { setError("올바른 날짜와 현재 시각 이후의 시간을 입력하세요."); return; }
          change.mutate({ action: "save", agentId, message, dueAt }, { onSuccess: close }); }}>
        {change.isPending ? "저장 중…" : pending ? "예약 변경" : "예약하기"}
      </Button>
    </View>
  </View>;
}

export function scheduleUI(client: PluginClientContext) {
  let focus: { id: string | null; edit: boolean } = { id: null, edit: false };
  const listeners = new Set<() => void>();
  const open = (id: string | null = null, edit = false) => { focus = { id, edit }; for (const listener of listeners) listener(); client.openSurface("scheduled-messages"); };
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  function Composer(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20 }}>
      <ScheduleForm key={props.agentId} agentId={props.agentId} colors={props.theme.colors} close={props.close} onOverview={() => { props.close(); open(); }} />
    </ScrollView>;
  }
  function Timeline(props: PluginTimelineItemProps<ScheduleTimeline>) {
    const job = props.item.data, colors = props.theme.colors, change = useScheduleChange();
    const [deleting, setDeleting] = useState(false);
    if ("deleted" in job) return null;
    return <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, borderRadius: 12 }}>
      <Pressable accessibilityRole="button" accessibilityLabel="예약 메시지 목록에서 보기" onPress={() => open(job.id)} style={{ flexDirection: "row", gap: 10, alignItems: "center", minHeight: 44 }}>
        <Icon name="CalendarClock" size={20} color={colors.accent} />
        <View style={{ flex: 1, gap: 3 }}><Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600" }}>예약 메시지 · {job.waitingFor === "quota" ? "초기화 시각 조회 대기" : scheduleLabels[job.status]}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{job.waitingFor === "quota" ? "다음 한도 조회 · " : ""}{dateLabel(job.dueAt)}</Text></View>
        <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
      </Pressable>
      <Text style={{ color: colors.foreground, fontSize: 15, lineHeight: 23 }}>{job.message}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{job.reason}</Text>
      {(job.status === "waiting" || job.status === "attention") && <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button colors={colors} onPress={() => open(job.id, true)}>수정</Button>
        <Button colors={colors} disabled={change.isPending} onPress={() => change.mutate({ action: "cancel", id: job.id })}>취소</Button>
      </View>}
      {finishedSchedule(job) && <View style={{ alignItems: "flex-start" }}><Button colors={colors} danger icon="Trash2" onPress={() => setDeleting(true)}>삭제</Button></View>}
      {change.error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{publicError(change.error)}</Text>}
      {deleting && <DeleteScheduleModal job={job} colors={colors} close={() => setDeleting(false)} />}
    </View>;
  }
  function Surface(props: PluginSurfaceProps) {
    const colors = props.theme.colors, query = useSchedules(), change = useScheduleChange();
    const selected = useSyncExternalStore(subscribe, () => focus), [editAgent, setEditAgent] = useState<string | null>(null);
    const [tab, setTab] = useState<"active" | "history">("active"), [deleting, setDeleting] = useState<ScheduleCard | null>(null);
    const focusedJob = query.data?.jobs.find(j => j.id === selected.id);
    useEffect(() => {
      if (!focusedJob) return;
      setTab(finishedSchedule(focusedJob) ? "history" : "active");
      if (selected.edit && (focusedJob.status === "waiting" || focusedJob.status === "attention")) setEditAgent(focusedJob.agentId);
    }, [selected, focusedJob?.id, focusedJob?.status, focusedJob?.agentId]);
    const jobs = query.data?.jobs ?? [], activeCount = jobs.filter(job => !finishedSchedule(job)).length;
    const visibleJobs = jobs.filter(job => finishedSchedule(job) === (tab === "history"));
    return <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <ScrollView contentContainerStyle={{ padding: props.layout.compact ? 18 : 28, gap: 20, width: "100%", maxWidth: 1040, alignSelf: "center" }}>
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 26, fontWeight: "700" }}>예약 메시지</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 }}>Paseo 호스트가 실행 중이면 앱을 닫아도 동작합니다. 작업 중에는 종료를 기다립니다.</Text>
        </View>
        <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 10, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border }}>
          {(["active", "history"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} aria-selected={tab === value}
            onPress={() => setTab(value)} style={({ pressed }) => ({ flex: 1, minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
              borderRadius: 7, backgroundColor: tab === value ? colors.surface2 : colors.surface1, opacity: pressed ? 0.8 : 1 })}>
            <Text style={{ color: tab === value ? colors.foreground : colors.foregroundMuted, fontSize: 14, fontWeight: tab === value ? "600" : "400" }}>{value === "active" ? "활성 예약" : "완료·취소"}</Text>
            {query.data && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{value === "active" ? activeCount : jobs.length - activeCount}</Text>}
          </Pressable>)}
        </View>
        {tab === "history" && <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>완료·취소 후 30일이 지나면 자동으로 삭제됩니다. 이미 전송된 메시지와 대화는 유지됩니다.</Text>}
        {query.isPending && <ActivityIndicator color={colors.accent} accessibilityLabel="예약 목록 불러오는 중" />}
        {query.isError && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{publicError(query.error)}</Text>}
        {query.data && visibleJobs.length === 0 && <View style={{ paddingVertical: 40, gap: 8 }}>
          <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{tab === "active" ? "활성 예약이 없습니다" : "완료·취소된 예약이 없습니다"}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 }}>{tab === "active" ? "채팅 입력창의 예약 버튼에서 메시지와 시간을 지정하세요." : "종료된 예약 기록은 이곳에서 확인하고 삭제할 수 있습니다."}</Text>
        </View>}
        {visibleJobs.map(job => <View key={job.id} style={{ gap: 14, padding: 18, borderRadius: 12, borderWidth: 1,
          borderColor: selected.id === job.id ? colors.accent : colors.border, backgroundColor: colors.surface1 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${job.title} 채팅 열기`} disabled={!props.navigation}
            onPress={() => props.navigation?.openAgent({ agentId: job.agentId })} style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>
            <Icon name="CalendarClock" size={22} color={colors.accent} />
            <View style={{ flex: 1, gap: 5 }}><Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "600" }}>{job.title}</Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{harnessLabels[job.harness]} · {job.accountLabel}</Text></View>
            <Text style={{ color: job.status === "attention" ? colors.statusWarning : colors.foregroundMuted, fontSize: 13 }}>{job.waitingFor === "quota" ? "조회 대기" : scheduleLabels[job.status]}</Text>
            {props.navigation && <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />}
          </Pressable>
          <Text style={{ color: colors.foreground, fontSize: 15, lineHeight: 23 }}>{job.message}</Text>
          <View style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 14 }}>{job.waitingFor === "quota" ? "다음 한도 조회 · " : ""}{dateLabel(job.dueAt)}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{job.reason}</Text></View>
          {(job.status === "waiting" || job.status === "attention") && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button colors={colors} onPress={() => setEditAgent(job.agentId)}>수정</Button>
            <Button colors={colors} disabled={change.isPending} onPress={() => change.mutate({ action: "cancel", id: job.id })}>취소</Button>
          </View>}
          {finishedSchedule(job) && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>자동 삭제 · {dateLabel(new Date(Date.parse(job.finishedAt ?? job.updatedAt) + scheduleRetentionMs).toISOString())}</Text>
            <Button colors={colors} danger icon="Trash2" onPress={() => setDeleting(job)}>삭제</Button>
          </View>}
        </View>)}
        {change.error && <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>{publicError(change.error)}</Text>}
        {!props.navigation && <Text style={{ color: colors.foregroundMuted }}>채팅으로 바로 이동하려면 Paseo 앱을 업데이트하세요.</Text>}
        <View style={{ alignItems: "flex-start", paddingTop: 8 }}><Button colors={colors} icon="RefreshCw" disabled={query.isFetching} onPress={() => { void query.refetch(); }}>새로고침</Button></View>
      </ScrollView>
      <Modal title="예약 수정" open={editAgent !== null} onOpenChange={value => { if (!value) { setEditAgent(null); focus = { ...focus, edit: false }; } }}>
        <Modal.Content>{editAgent && <ScheduleForm key={editAgent} agentId={editAgent} colors={colors} close={() => { setEditAgent(null); focus = { ...focus, edit: false }; }} onOverview={() => setEditAgent(null)} />}</Modal.Content>
      </Modal>
      {deleting && <DeleteScheduleModal job={deleting} colors={colors} close={() => setDeleting(null)} />}
    </View>;
  }
  return { Composer, Timeline, Surface };
}
