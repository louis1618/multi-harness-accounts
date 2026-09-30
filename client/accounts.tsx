import { useRpc, type PluginSurfaceProps, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, ScrollView as SheetScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsInput, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { changeAccount, harnessLabels, formatResetCountdown, listAccounts, listSessions, importAccountSession, prepareReset, consumeReset,
  type Action, type Harness, type Metrics, type Snapshot } from "../shared/accounts.js";
import { serviceLogos } from "./branding.js";

type Colors = PluginSurfaceProps["theme"]["colors"];
type Row = { id: string | null; harness: Harness; label: string; email: string | null; status: string; error: string | null; metrics: Metrics };
const number = (value: number) => new Intl.NumberFormat("ko-KR").format(value);
const compact = (value: number) => new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const date = (value: string) => new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const errorMessage = (error: Error | null) => {
  const message = error?.message ?? "", start = message.search(/[가-힣]/);
  return start >= 0 ? message.slice(start).split(" requestType=")[0] : "작업을 완료하지 못했습니다. 로그인과 연결 상태를 확인하고 다시 시도하세요.";
};
const statusLabel: Record<string, string> = { idle: "대기 중", running: "실행 중", initializing: "준비 중", closed: "닫힌 세션", error: "확인 필요" };
function Button({ children, onPress, colors, disabled = false, icon, primary = false, danger = false }: {
  children: ReactNode; onPress: () => void; colors: Colors; disabled?: boolean; icon?: string; primary?: boolean; danger?: boolean;
}) {
  const color = primary ? colors.accentForeground : danger ? colors.statusDanger : colors.foreground;
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
      flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7,
      backgroundColor: primary ? colors.accent : pressed ? colors.surface2 : colors.surface1,
      borderWidth: primary ? 0 : 1, borderColor: colors.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 })}>
    {icon && <Icon name={icon} size={16} color={color} />}
    <Text style={{ color, fontSize: 14, fontWeight: "500" }}>{children}</Text>
  </Pressable>;
}
function Badge({ children, colors, active = false }: { children: ReactNode; colors: Colors; active?: boolean }) {
  return <Text style={{ color: active ? colors.accent : colors.foregroundMuted, backgroundColor: colors.surface2,
    fontSize: 12, fontWeight: "600", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 5 }}>{children}</Text>;
}
function ServiceHeader({ harness, colors, children }: { harness: Harness; colors: Colors; children?: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
    <Image accessible accessibilityLabel={`${harnessLabels[harness]} 로고`} source={{ uri: serviceLogos[harness] }}
      style={{ width: 48, height: 48 }} resizeMode="contain" />
    <View style={{ flex: 1, minWidth: 140 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 24, fontWeight: "700" }}>{harnessLabels[harness]}</Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: 14, marginTop: 3 }}>네이티브 로그인 계정</Text>
    </View>
    {children}
  </View>;
}
function QuotaDetails({ row, colors, onReset, now }: { row: Row; colors: Colors; onReset: () => void; now: number }) {
  const quota = row.metrics.quota;
  return <View style={{ gap: 12 }}>
    {quota.windows.map(window => <View key={window.id} style={{ gap: 7 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 4 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{window.label}</Text>
        <Text style={{ color: colors.foreground, fontSize: 14, fontVariant: ["tabular-nums"] }}>사용 {number(window.usedPercent)}% · 남음 {number(100 - window.usedPercent)}%</Text>
      </View>
      <View accessibilityRole="progressbar" accessibilityLabel={window.label}
        accessibilityValue={{ min: 0, max: 100, now: window.usedPercent, text: `사용 ${window.usedPercent}%` }}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.usedPercent} aria-valuetext={`사용 ${window.usedPercent}%`}
        style={{ height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" }}>
        <View style={{ height: 6, width: `${window.usedPercent}%`,
          backgroundColor: window.usedPercent >= 90 ? colors.statusDanger : window.usedPercent >= 75 ? colors.statusWarning : colors.statusSuccess }} />
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{window.resetsAt ? `초기화 ${date(window.resetsAt)} · ${formatResetCountdown(window.resetsAt, now)}` : "초기화 시각 미제공"}</Text>
    </View>)}
    {quota.status === "loading" && <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 14 }}>한도 조회 중…</Text>}
    {quota.status === "available" && quota.windows.length === 0 && <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>제공되는 5시간·주간 한도가 없습니다.</Text>}
    {quota.error && <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 21 }}>{quota.error}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{quota.resetCredits ? `리셋권 ${number(quota.resetCredits.availableCount)}${row.harness === "claude" ? "회" : "개"}` : "리셋권 정보 미제공"}</Text>
      <Button colors={colors} icon="Ticket" disabled={row.status !== "signed-in"} onPress={onReset}>{row.harness === "claude" && (!quota.resetCredits || quota.resetCredits.availableCount === 0) ? "리셋권 보기" : "리셋권 사용"}</Button>
    </View>
    {quota.resetError && <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{quota.resetError}</Text>}
    {quota.resetCredits?.reason && <Text style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 }}>{quota.resetCredits.reason}</Text>}
    {quota.fetchedAt && <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
      {quota.status === "error" || quota.status === "auth-required" ? "마지막 확인값" : "한도 확인"} · {date(quota.fetchedAt)}
    </Text>}
  </View>;
}
function Dashboard({ data, rows, colors }: { data: Snapshot; rows: Row[]; colors: Colors }) {
  const summary = data.summary, ranked = rows.filter(row => row.metrics.statistics.available && !row.metrics.sharedStatisticsWith)
    .sort((a, b) => b.metrics.statistics.totalTokens - a.metrics.statistics.totalTokens);
  const parts = [
    { label: "일반 입력", value: Math.max(0, summary.inputTokens - summary.cachedInputTokens - summary.cacheWriteInputTokens), color: colors.foreground },
    { label: "캐시 읽기", value: summary.cachedInputTokens, color: colors.statusSuccess },
    { label: "캐시 쓰기", value: summary.cacheWriteInputTokens, color: colors.statusWarning },
    { label: "출력", value: summary.outputTokens, color: colors.accent },
  ];
  return <View style={{ gap: 28 }}>
    <View style={{ gap: 18, paddingVertical: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>Paseo 사용량</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{date(summary.startedAt)}부터 집계</Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 24 }}>
        {[{ label: "누적 토큰", value: summary.totalTokens }, { label: "실행한 턴", value: summary.turns },
          { label: "캐시 입력 토큰", value: summary.cachedInputTokens + summary.cacheWriteInputTokens }].map(item =>
          <View key={item.label} style={{ flexGrow: 1, flexBasis: 190, gap: 6 }}>
            <Text accessibilityLabel={`${item.label} ${number(item.value)}`} style={{ color: colors.foreground, fontSize: 36, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{compact(item.value)}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{item.label}</Text>
          </View>)}
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 }}>기능 적용 이후 Paseo에서 실행한 사용량입니다. 입력에는 캐시 토큰이 포함됩니다.</Text>
      {summary.incompleteTurns > 0 && <Text style={{ color: colors.statusWarning, fontSize: 14 }}>집계 불완전 · {number(summary.incompleteTurns)}턴의 사용량을 모두 확인하지 못했습니다.</Text>}
    </View>
    <View style={{ gap: 16, paddingTop: 24, borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>토큰 구성</Text>
      {summary.totalTokens > 0 ? <View style={{ height: 14, flexDirection: "row", borderRadius: 5, overflow: "hidden", backgroundColor: colors.surface2 }}>
        {parts.map(part => part.value > 0 && <View key={part.label} accessibilityLabel={`${part.label} ${number(part.value)} 토큰`}
          style={{ width: `${part.value / summary.totalTokens * 100}%`, backgroundColor: part.color }} />)}
      </View> : <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>에이전트에서 작업을 실행하면 사용량이 표시됩니다.</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
        {parts.map(part => <View key={part.label} style={{ flexGrow: 1, flexBasis: 170, gap: 5 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 14 }}>{part.label}</Text>
          <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{number(part.value)}</Text>
        </View>)}
      </View>
    </View>
    <View style={{ gap: 18, paddingTop: 24, borderTopWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>계정별 사용량</Text>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" }}>
        {ranked.length === 0 && <Text style={{ padding: 20, color: colors.foregroundMuted, fontSize: 14 }}>로그인한 계정을 확인하면 통계를 집계할 수 있습니다.</Text>}
        {ranked.map((row, index) => {
          const stats = row.metrics.statistics, percent = summary.totalTokens ? stats.totalTokens / summary.totalTokens * 100 : 0;
          return <View key={row.id ?? `system:${row.harness}`} style={{ padding: 20, gap: 12, backgroundColor: colors.surface1,
            borderTopWidth: index ? 1 : 0, borderColor: colors.border }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
              <Image source={{ uri: serviceLogos[row.harness] }} style={{ width: 28, height: 28 }} resizeMode="contain" />
              <View style={{ flex: 1, minWidth: 140, gap: 4 }}>
                <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>{row.label}</Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{harnessLabels[row.harness]} · {row.email ?? "이메일 미제공"}</Text>
              </View>
              {row.metrics.isMostRecent && <Badge colors={colors} active>최근 사용</Badge>}
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                <Text style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>{compact(stats.totalTokens)} 토큰</Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{number(stats.turns)}턴 · {number(Math.round(percent * 10) / 10)}%</Text>
              </View>
            </View>
            <View style={{ height: 5, backgroundColor: colors.surface2, borderRadius: 3, overflow: "hidden" }}>
              <View style={{ height: 5, width: `${percent}%`, backgroundColor: colors.accent }} />
            </View>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>입력 {number(stats.inputTokens)} · 출력 {number(stats.outputTokens)} · 마지막 사용 {stats.lastUsedAt ? date(stats.lastUsedAt) : "아직 사용하지 않음"}</Text>
            {stats.incompleteTurns > 0 && <Text style={{ color: colors.statusWarning, fontSize: 13 }}>집계 불완전 · {number(stats.incompleteTurns)}턴</Text>}
          </View>;
        })}
      </View>
      {rows.some(row => row.metrics.sharedStatisticsWith) && <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>같은 로그인 계정의 여러 프로필은 통계를 한 번만 합산합니다.</Text>}
    </View>
  </View>;
}

export function AgentAccountsPanel(props: PluginAgentPanelProps) { return <AccountsSurface {...props} initialAgentId={props.agentId} />; }
export function AccountsSurface({ theme, layout, initialAgentId }: PluginSurfaceProps & { initialAgentId?: string }) {
  const colors = theme.colors, list = useRpc(listAccounts), change = useRpc(changeAccount);
  const fetchSessions = useRpc(listSessions), importSession = useRpc(importAccountSession);
  const prepare = useRpc(prepareReset), consume = useRpc(consumeReset), queryClient = useQueryClient();
  const [tab, setTab] = useState<"usage" | "accounts">(initialAgentId ? "accounts" : "usage");
  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [adding, setAdding] = useState<Harness | null>(null), [label, setLabel] = useState("");
  const [confirmation, setConfirmation] = useState<{ kind: "relogin" | "remove" | "logout"; row: Row } | null>(null);
  const [picking, setPicking] = useState(false), [search, setSearch] = useState(""), [filter, setFilter] = useState("all");
  const [resetTarget, setResetTarget] = useState<Row | null>(null), [creditId, setCreditId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const query = useQuery({ queryKey: ["accounts"], queryFn: () => list({}),
    refetchInterval: query => [...(query.state.data?.accounts ?? []), ...(query.state.data?.systemAccounts ?? [])]
      .some(row => row.status === "authenticating" || row.metrics.quota.status === "loading") || query.state.data?.agents.some(agent => agent.pending || agent.rotation && ["checking", "switching", "sending"].includes(agent.rotation.phase)) ? 3000 : 30000 });
  const mutation = useMutation({ mutationFn: (input: Action) => change(input), onMutate: () => setNotice(""),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["accounts"] }) });
  const sessionsQuery = useQuery({ queryKey: ["account-sessions"], enabled: picking, queryFn: () => fetchSessions({ refresh: true }), staleTime: 0 });
  const importMutation = useMutation({ mutationFn: (id: string) => importSession({ id }),
    onSuccess: result => { setAgentId(result.agentId); setPicking(false); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["accounts"] }); void queryClient.invalidateQueries({ queryKey: ["account-sessions"] }); } });
  const creditsQuery = useQuery({ queryKey: ["account-reset", resetTarget?.harness ?? "", resetTarget?.id ?? "system"], enabled: resetTarget !== null,
    queryFn: () => prepare({ accountId: resetTarget?.id ?? null, harness: resetTarget?.harness ?? "codex" }), retry: false, staleTime: 0 });
  const credits = creditsQuery.data?.quota.resetCredits;
  const usable = credits?.credits?.filter(credit => credit.status === "available" && credit.resetType === (resetTarget?.harness === "claude" ? "claudeRateLimits" : "codexRateLimits") &&
    (!credit.expiresAt || Date.parse(credit.expiresAt) > Date.now())).sort((a, b) => (a.grantedAt ?? "").localeCompare(b.grantedAt ?? "")) ?? [];
  const displayedCredits = resetTarget?.harness === "claude" ? credits?.credits ?? [] : usable;
  useEffect(() => {
    if (creditsQuery.data) setCreditId(creditsQuery.data.pending ? creditsQuery.data.creditId : usable[0]?.id ?? null);
  }, [creditsQuery.data]);
  const resetMutation = useMutation({ mutationFn: () => {
    if (!creditsQuery.data) throw Error("리셋권 목록을 먼저 조회하세요.");
    return consume({ attemptId: creditsQuery.data.attemptId, creditId, confirmed: true });
  }, onSuccess: result => {
    mutation.reset(); setResetTarget(null); setNotice(result.message);
  }, onError: () => { void creditsQuery.refetch(); },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["accounts"] }); } });
  const data = query.data, agent = data?.agents.find(row => row.id === agentId);
  const busy = mutation.isPending || importMutation.isPending || resetMutation.isPending;
  const detail = { color: colors.foregroundMuted, fontSize: 14, lineHeight: 22 };
  const rows: Row[] = data ? [
    ...data.systemAccounts.map(row => ({ ...row, id: null, label: "시스템 계정" })),
    ...data.accounts,
  ] : [];
  const name = (id: string | null, harness: Harness) => rows.find(row => row.id === id && row.harness === harness)?.label ?? "계정";
  const openReset = (row: Row) => {
    setCreditId(null); resetMutation.reset();
    void queryClient.removeQueries({ queryKey: ["account-reset"] });
    setResetTarget(row);
  };
  const modalSessions = sessionsQuery.data?.sessions.filter(session => (filter === "all" || session.harness === filter) &&
    (session.title + " " + session.cwd).toLowerCase().includes(search.toLowerCase())) ?? [];
  const confirmAction = () => {
    if (!confirmation) return;
    const { row, kind } = confirmation;
    const action: Action = row.id ? { action: kind === "remove" ? "remove" : "relogin", id: row.id } :
      { action: kind === "logout" ? "logout-system" : "relogin-system", harness: row.harness, confirmed: true };
    mutation.mutate(action, { onSuccess: () => setConfirmation(null) });
  };
  return <>
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{
      padding: layout.compact ? 16 : 28, gap: 28, width: "100%", maxWidth: 1100, alignSelf: "center" }}>
      <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 24, borderBottomWidth: 1, borderColor: colors.border }}>
        {(["usage", "accounts"] as const).map(value => <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: tab === value }} aria-selected={tab === value}
          onPress={() => setTab(value)} style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 14,
            borderBottomWidth: 2, borderBottomColor: tab === value ? colors.accent : "transparent" }}>
          <Icon name={value === "usage" ? "ChartNoAxesCombined" : "Users"} size={18} color={tab === value ? colors.foreground : colors.foregroundMuted} />
          <Text style={{ color: tab === value ? colors.foreground : colors.foregroundMuted, fontSize: 16, fontWeight: "600" }}>{value === "usage" ? "사용량" : "계정"}</Text>
        </Pressable>)}
      </View>
      {(query.isLoading || busy) && <ActivityIndicator accessibilityLabel="계정 정보 처리 중" color={colors.accent} />}
      {(query.error || mutation.error) && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{errorMessage(mutation.error ?? query.error)}</Text>}
      {(notice || mutation.data?.message) && <Text accessibilityLiveRegion="polite" style={detail}>{notice || mutation.data?.message}</Text>}
      {data && tab === "usage" && <Dashboard data={data} rows={rows} colors={colors} />}
      {data && tab === "accounts" && <>
        {(["codex", "claude"] as const).map(harness => <View key={harness} style={{ gap: 18 }}>
          <ServiceHeader harness={harness} colors={colors}>
            <Button colors={colors} icon="Plus" disabled={busy || rows.some(row => row.harness === harness && row.status === "authenticating")}
              onPress={() => { mutation.reset(); setLabel(""); setAdding(harness); }}>계정 추가</Button>
          </ServiceHeader>
          <SettingsSwitch label="사용량 소진 시 자동 계정 전환" value={data.rotation[harness]} disabled={busy}
            hint="같은 하네스의 다음 로그인 계정으로 전환해 중단된 작업을 이어갑니다. 기본 계정은 유지하며 리셋권을 사용하지 않습니다."
            onValueChange={enabled => mutation.mutate({ action: "set-rotation", harness, enabled })} />
          {data.agents.filter(agent => agent.harness === harness && agent.rotation).map(agent => <View key={agent.id} style={{ gap: 8 }}>
            <Text accessibilityLiveRegion="polite" style={detail}>{agent.title} · {agent.rotation!.message}</Text>
            {["error", "stopped"].includes(agent.rotation!.phase) && data.rotation[harness] && <View style={{ flexDirection: "row" }}>
              <Button colors={colors} disabled={busy} onPress={() => mutation.mutate({ action: "retry-rotation", agentId: agent.id })}>자동 전환 다시 확인</Button>
            </View>}
          </View>)}
          {rows.filter(row => row.harness === harness).map(row => <View key={row.id ?? "system"} style={{
            backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: layout.compact ? 18 : 22, gap: 18 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <View style={{ flexGrow: 1, flexBasis: 220, minWidth: 0, gap: 7 }}>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600", flexShrink: 1 }}>{row.label}</Text>
                  {data.defaults[harness] === row.id && <Badge colors={colors} active>기본 계정</Badge>}
                  {row.metrics.isMostRecent && <Badge colors={colors}>최근 사용</Badge>}
                  {row.metrics.quota.plan && <Badge colors={colors}>{row.metrics.quota.plan}</Badge>}
                </View>
                <Text style={detail}>{row.email ?? (row.status === "authenticating" ? "브라우저 인증 대기 중…" : row.status === "signed-in" ? "로그인됨 · 이메일 미제공" : "로그인 필요")}</Text>
                {!row.id && <Text style={{ ...detail, fontSize: 12 }}>이 호스트의 기본 CLI 로그인</Text>}
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}>
                <Button colors={colors} disabled={busy || row.status !== "signed-in" || data.defaults[harness] === row.id}
                  onPress={() => mutation.mutate({ action: "select", harness, accountId: row.id })}>전환</Button>
                {row.status === "authenticating" ? <Button colors={colors} disabled={busy} onPress={() => mutation.mutate(row.id ?
                  { action: "cancel-login", id: row.id } : { action: "cancel-system-login", harness })}>로그인 취소</Button> :
                  <Button colors={colors} disabled={busy || rows.some(item => item.harness === harness && item.status === "authenticating")}
                    onPress={() => { mutation.reset(); setConfirmation({ kind: "relogin", row }); }}>다시 로그인</Button>}
                <Button colors={colors} danger disabled={busy || !row.id && row.status !== "signed-in"}
                  onPress={() => { mutation.reset(); setConfirmation({ kind: row.id ? "remove" : "logout", row }); }}>{row.id ? "삭제" : "로그아웃"}</Button>
              </View>
            </View>
            {row.error && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{row.error}</Text>}
            <QuotaDetails row={row} colors={colors} now={now} onReset={() => openReset(row)} />
          </View>)}
        </View>)}
        <View style={{ gap: 18, paddingTop: 24, borderTopWidth: 1, borderColor: colors.border }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: "600" }}>에이전트별 계정</Text>
          <Text style={detail}>기존 세션을 선택해 기본 계정과 다른 로그인을 지정할 수 있습니다.</Text>
          <View style={{ flexDirection: "row" }}><Button colors={colors} icon="FolderOpen" disabled={busy}
            onPress={() => { setSearch(""); setFilter("all"); importMutation.reset(); setPicking(true); }}>{agent?.title ?? "에이전트 선택"}</Button></View>
          {agent && <View style={{ gap: 12 }}>
            <SettingsSelect label="이 세션에서 사용할 계정" value={agent.override} disabled={busy}
              options={[{ label: "기본 계정 사용", value: "inherit" }, { label: "시스템 계정", value: "system" },
                ...data.accounts.filter(row => row.harness === agent.harness && (row.status === "signed-in" || row.id === agent.override))
                  .map(row => ({ label: row.label, value: row.id }))]}
              onValueChange={value => mutation.mutate(value === "inherit" ? { action: "inherit", agentId: agent.id } :
                { action: "select", harness: agent.harness, agentId: agent.id, accountId: value === "system" ? null : value })} />
            <Text style={detail}>{harnessLabels[agent.harness]} · {statusLabel[agent.status] ?? agent.status} · 현재 {name(agent.currentAccountId, agent.harness)} · 선택 {name(agent.desiredAccountId, agent.harness)}</Text>
            {agent.pending && <Text style={detail}>{agent.status === "closed" ? "다음에 세션을 열면 적용됩니다." : agent.status === "running" ? "현재 작업이 끝나면 계정을 전환합니다." : "계정 전환 대기 중입니다."}</Text>}
            {agent.error && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{agent.error}</Text>}
            {agent.pending && <View style={{ flexDirection: "row" }}><Button colors={colors} disabled={busy}
              onPress={() => mutation.mutate({ action: "retry", agentId: agent.id })}>전환 다시 시도</Button></View>}
          </View>}
        </View>
      </>}
      <View style={{ paddingTop: 22, marginTop: 4, borderTopWidth: 1, borderColor: colors.border,
        flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ ...detail, fontSize: 13 }}>한도는 5분간 캐시됩니다. 화면은 자동으로 갱신됩니다.</Text>
        <Button colors={colors} icon="RefreshCw" disabled={busy || query.isFetching} onPress={() => {
          setNotice(""); mutation.mutate({ action: "refresh-usage" });
        }}>새로고침</Button>
      </View>
    </ScrollView>
    <Modal title={adding ? `${harnessLabels[adding]} 계정 추가` : "계정 추가"} open={adding !== null} onOpenChange={open => { if (!open && !busy) setAdding(null); }}>
      <Modal.Content>
        {mutation.error && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{errorMessage(mutation.error)}</Text>}
        <SettingsInput label="계정 이름" initialValue="" placeholder="개인 계정 또는 업무 계정" onChangeText={setLabel} disabled={busy} />
        <Text style={detail}>호스트의 기본 브라우저에서 인증합니다. 계정별 로그인·설정·대화 기록은 독립된 프로필에 저장됩니다.</Text>
        <Button colors={colors} primary disabled={busy || !label.trim()} onPress={() => {
          if (adding) mutation.mutate({ action: "add", harness: adding, label: label.trim() }, { onSuccess: () => setAdding(null) });
        }}>브라우저에서 로그인</Button>
      </Modal.Content>
    </Modal>
    <Modal title={confirmation?.kind === "relogin" ? "다시 로그인 확인" : confirmation?.kind === "logout" ? "시스템 계정 로그아웃" : "계정 삭제"}
      open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
      <Modal.Content>
        <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{confirmation?.row.label}</Text>
        <Text style={detail}>{confirmation?.row.email ?? harnessLabels[confirmation?.row.harness ?? "codex"]}</Text>
        <Text style={{ color: colors.foreground, fontSize: 16, lineHeight: 25 }}>
          {confirmation?.kind === "relogin" ? confirmation.row.id ?
            "저장된 로그인을 해제한 뒤 기본 브라우저에서 다시 인증합니다. 실행 중인 작업을 먼저 완료해 주세요. 설정과 대화 기록은 유지됩니다." :
            "이 호스트의 기본 CLI 로그인을 해제한 뒤 기본 브라우저에서 다시 인증합니다. 다른 앱에서 사용하는 기본 로그인도 변경됩니다. 설정과 대화 기록은 유지됩니다." :
            confirmation?.kind === "logout" ? "이 호스트의 기본 CLI 로그인을 해제합니다. 설정과 대화 기록은 삭제하지 않습니다. 열린 에이전트는 먼저 닫거나 다른 계정으로 전환해 주세요." :
            "이 계정의 인증 정보와 독립 프로필을 삭제합니다. 닫힌 에이전트의 대화 기록은 보존됩니다."}
        </Text>
        {mutation.error && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{errorMessage(mutation.error)}</Text>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          <Button colors={colors} primary={confirmation?.kind === "relogin"} danger={confirmation?.kind !== "relogin"} disabled={busy} onPress={confirmAction}>
            {confirmation?.kind === "relogin" ? "확인 후 다시 로그인" : confirmation?.kind === "logout" ? "확인 후 로그아웃" : "계정 삭제"}
          </Button>
          <Button colors={colors} disabled={busy} onPress={() => setConfirmation(null)}>취소</Button>
        </View>
      </Modal.Content>
    </Modal>
    <Modal title="기존 세션 선택" open={picking} onOpenChange={open => { if (!open && !importMutation.isPending) setPicking(false); }}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 20, gap: 16 }}>
        <TextInput accessibilityLabel="세션 검색" placeholder="세션 이름 또는 작업 폴더 검색" placeholderTextColor={colors.foregroundMuted}
          value={search} onChangeText={setSearch} style={{ color: colors.foreground, backgroundColor: colors.surface2, borderRadius: 8, padding: 12, fontSize: 16 }} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {["all", "codex", "claude"].map(value => <Button key={value} colors={colors} primary={filter === value}
            onPress={() => setFilter(value)}>{value === "all" ? "전체" : harnessLabels[value as Harness]}</Button>)}
        </View>
        {(sessionsQuery.isFetching || importMutation.isPending) && <ActivityIndicator accessibilityLabel="세션 불러오는 중" color={colors.accent} />}
        {(sessionsQuery.error || importMutation.error) && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{errorMessage(importMutation.error ?? sessionsQuery.error)}</Text>}
        <SheetScrollView style={{ maxHeight: layout.compact ? 360 : 460 }} contentContainerStyle={{ gap: 2 }}>
          {modalSessions.map(session => <Pressable key={session.id} accessibilityRole="button" disabled={importMutation.isPending}
            onPress={() => {
              if (session.agentId) { setAgentId(session.agentId); setPicking(false); void query.refetch(); }
              else importMutation.mutate(session.id);
            }} style={({ pressed }) => ({ paddingVertical: 16, paddingHorizontal: 8, flexDirection: "row", gap: 12,
              backgroundColor: pressed ? colors.surface2 : colors.surface1, borderBottomWidth: 1, borderColor: colors.border })}>
            <Image source={{ uri: serviceLogos[session.harness] }} style={{ width: 24, height: 24, marginTop: 2 }} resizeMode="contain" />
            <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
              <Text numberOfLines={2} style={{ color: colors.foreground, fontSize: 16, lineHeight: 23, fontWeight: "500" }}>{session.title}</Text>
              <Text numberOfLines={1} style={{ ...detail, fontSize: 13 }}>{session.cwd || "작업 폴더 미제공"}</Text>
              <Text style={{ ...detail, fontSize: 12 }}>{harnessLabels[session.harness]} · {session.source === "paseo" ? "Paseo 세션" : "외부 CLI · 선택하면 불러오기"}
                {session.updatedAt ? ` · ${date(session.updatedAt)}` : ""}</Text>
            </View>
          </Pressable>)}
          {!sessionsQuery.isLoading && modalSessions.length === 0 && <Text style={{ ...detail, paddingVertical: 18 }}>일치하는 세션이 없습니다. 검색 조건을 바꾸거나 목록을 새로고침하세요.</Text>}
        </SheetScrollView>
        {sessionsQuery.data?.warnings.map(warning => <Text key={warning} style={detail}>{warning}</Text>)}
        <Text style={{ ...detail, fontSize: 12 }}>Paseo 세션과 각 프로필의 최근 외부 CLI 기록을 표시합니다. 외부 기록은 현재 기본 계정으로 불러오며 원본 대화를 보존합니다.</Text>
        <Button colors={colors} icon="RefreshCw" disabled={sessionsQuery.isFetching || importMutation.isPending} onPress={() => void sessionsQuery.refetch()}>목록 새로고침</Button>
      </Modal.Content>
    </Modal>
    <Modal title={`${harnessLabels[resetTarget?.harness ?? "codex"]} 리셋권`} open={resetTarget !== null} onOpenChange={open => { if (!open && !resetMutation.isPending) setResetTarget(null); }}>
      <Modal.Content>
        <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "600" }}>{resetTarget?.label}</Text>
        <Text style={detail}>{resetTarget?.email ?? "시스템 계정"}</Text>
        {creditsQuery.isFetching && <ActivityIndicator accessibilityLabel="리셋권 조회 중" color={colors.accent} />}
        {(creditsQuery.error || resetMutation.error) && <Text accessibilityRole="alert" style={{ ...detail, color: colors.statusDanger }}>{errorMessage(resetMutation.error ?? creditsQuery.error)}</Text>}
        {creditsQuery.data && <>
          <Text style={{ color: colors.foreground, fontSize: 16 }}>보유 리셋권 {credits ? number(credits.availableCount) + (resetTarget?.harness === "claude" ? "회" : "개") : "정보 미제공"}</Text>
          {creditsQuery.data.pending && <Text style={{ ...detail, color: colors.statusWarning }}>이전 요청의 결과를 확인하지 못했습니다. 선택을 유지하고 같은 요청으로 다시 확인합니다.</Text>}
          {creditsQuery.data.quota.resetError && <Text style={detail}>{creditsQuery.data.quota.resetError}</Text>}
          {credits?.reason && <Text style={detail}>{credits.reason}</Text>}
          {displayedCredits.map((credit, index) => <Pressable key={credit.id} accessibilityRole="radio" accessibilityState={{ checked: creditId === credit.id, disabled: creditsQuery.data?.pending || credit.status !== "available" }} aria-checked={creditId === credit.id}
            disabled={creditsQuery.data?.pending || resetMutation.isPending || credit.status !== "available"} onPress={() => setCreditId(credit.id)}
            style={{ padding: 16, borderWidth: 1, borderColor: creditId === credit.id ? colors.accent : colors.border,
              borderRadius: 10, backgroundColor: colors.surface1, gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Icon name={creditId === credit.id ? "CircleCheck" : "Circle"} size={18} color={creditId === credit.id ? colors.accent : colors.foregroundMuted} />
              <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "600" }}>리셋권 #{index + 1}</Text>
              {credit.remaining === 0 ? <Badge colors={colors}>사용 완료</Badge> : credit.status !== "available" ? <Badge colors={colors}>사용 불가</Badge> :
                index === 0 && <Badge colors={colors}>먼저 받은 리셋권</Badge>}
            </View>
            {resetTarget?.harness === "claude" && <>
              <Text style={detail}>남은 횟수 · {number(credit.remaining ?? 0)} / {number(credit.total ?? 0)}회</Text>
              <Text style={detail}>초기화 대상 · {credit.clears?.map(window => window === "five_hour" ? "5시간 한도" : window === "seven_day" ? "주간 한도" : "주간 추가 한도").join(", ") || "미제공"}</Text>
              {credit.blockedReason && <Text style={detail}>{credit.blockedReason}</Text>}
            </>}
            <Text style={detail}>{resetTarget?.harness === "claude" ? "시작일" : "받은 날"} · {credit.grantedAt ? date(credit.grantedAt) : "미제공"}</Text>
            <Text style={detail}>만료 · {credit.expiresAt ? date(credit.expiresAt) : "미제공"}</Text>
          </Pressable>)}
          {resetTarget?.harness === "codex" && credits && credits.availableCount > 0 && credits.credits === null && <View style={{ gap: 8 }}>
            <Text style={detail}>서비스가 선택 가능한 상세 목록을 제공하지 않았습니다. 서비스가 사용 가능한 리셋권을 선택합니다.</Text>
            <Button colors={colors} disabled={creditsQuery.data.pending} onPress={() => setCreditId(null)}>서비스에서 선택</Button>
          </View>}
          <Text style={detail}>{resetTarget?.harness === "claude" ? "사용이 승인되면 선택한 리셋권에서 1회가 소모되며 취소할 수 없습니다. 서비스의 현재 지급·사용 조건이 적용됩니다." :
            "사용이 승인되면 리셋권 1개가 소모되며 취소할 수 없습니다. 초기화 가능한 한도가 없으면 리셋권은 소모되지 않습니다."}</Text>
          <Button colors={colors} primary icon="Ticket" disabled={resetMutation.isPending || creditsQuery.isFetching ||
            !creditsQuery.data.pending && (!credits || credits.availableCount === 0 || resetTarget?.harness === "claude" && !usable.some(credit => credit.id === creditId))} onPress={() => resetMutation.mutate()}>
            {creditsQuery.data.pending ? "같은 요청으로 결과 확인" : resetTarget?.harness === "claude" ? "선택한 리셋권 1회 사용" : "선택한 리셋권 1개 사용"}
          </Button>
        </>}
        <Button colors={colors} icon="RefreshCw" disabled={creditsQuery.isFetching || resetMutation.isPending} onPress={() => void creditsQuery.refetch()}>리셋권 다시 조회</Button>
      </Modal.Content>
    </Modal>
  </>;
}
