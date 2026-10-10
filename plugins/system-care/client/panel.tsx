import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  TextInput,
  ScrollView as SheetScrollView,
} from "@getpaseo/plugin/client/react-native";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { Button } from "./ui.js";
import {
  snapshotRpc,
  scanRpc,
  previewRpc,
  executeRpc,
  jobsRpc,
  settingsRpc,
  logsRpc,
  helperRpc,
  autoCleanRpc,
  bytes,
  type Request,
  type Candidate,
  type Settings,
} from "../shared/care.js";
const tabs = {
    summary: "요약",
    clean: "정리",
    resources: "리소스",
    docker: "Docker",
  },
  dockerTabs = {
    containers: "컨테이너",
    images: "이미지",
    volumes: "볼륨",
    networks: "네트워크",
    stacks: "Compose",
  };
const jobLabel: Record<string, string> = {
  waiting: "대기 중",
  running: "실행 중",
  done: "완료",
  partial: "일부 완료",
  error: "확인 필요",
  interrupted: "중단됨",
  canceled: "취소됨",
  pending: "대기 중",
  skipped: "보호·건너뜀",
};
const scanLabel: Record<string, string> = {
  idle: "분석 준비",
  running: "분석 중",
  done: "분석 완료",
  partial: "일부 미조회",
  canceled: "분석 취소",
  error: "분석 오류",
};
const pct = (n: number | null) => (n === null ? "측정 중" : `${n.toFixed(1)}%`),
  date = (s: string) => new Date(s).toLocaleString("ko-KR");
function errorText(e: Error) {
  const i = e.message.search(/[가-힣]/);
  return i >= 0
    ? e.message.slice(i).split(" requestType=")[0]
    : "연결과 호스트 상태를 확인하고 다시 시도하세요.";
}
function candidateRequest(c: Candidate): Request {
  return {
    action: c.action,
    target: c.id.replace(/^(?:image|network|builder):/, ""),
  };
}
export function CarePanel({ theme, layout, host }: PluginSurfaceProps) {
  const c = theme.colors,
    qc = useQueryClient(),
    snapshot = useRpc(snapshotRpc),
    scan = useRpc(scanRpc),
    preview = useRpc(previewRpc),
    execute = useRpc(executeRpc),
    fetchJobs = useRpc(jobsRpc),
    settingsRpcCall = useRpc(settingsRpc),
    logs = useRpc(logsRpc),
    setup = useRpc(helperRpc),
    autoClean = useRpc(autoCleanRpc);
  const [tab, setTab] = useState<keyof typeof tabs>("summary"),
    [dockerTab, setDockerTab] = useState<keyof typeof dockerTabs>("containers"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [showProtected, setShowProtected] = useState(false),
    [dialog, setDialog] = useState<
      "confirm" | "history" | "settings" | "logs" | null
    >(null),
    [notice, setNotice] = useState(""),
    [plan, setPlan] = useState<Awaited<ReturnType<typeof preview>> | null>(
      null,
    ),
    [logId, setLogId] = useState(""),
    [draft, setDraft] = useState<Settings | null>(null),
    [settingsText, setSettingsText] = useState<Record<string, string>>({});
  const wantDocker = tab !== "resources";
  const query = useQuery({
    queryKey: ["care", host.id, wantDocker],
    queryFn: () => snapshot({ docker: wantDocker }),
    refetchInterval: 5000,
    retry: false,
  });
  const jobQuery = useQuery({
    queryKey: ["care-jobs", host.id],
    queryFn: () => fetchJobs({}),
    enabled:
      dialog === "history" ||
      query.data?.jobs.some((j) =>
        ["waiting", "running"].includes(j.status),
      ) === true,
    refetchInterval: 2000,
    retry: false,
  });
  const logQuery = useQuery({
    queryKey: ["care-logs", host.id, logId],
    queryFn: () => logs({ id: logId, tail: 100 }),
    enabled: dialog === "logs" && !!logId,
    retry: false,
  });
  const op = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["care", host.id] });
      void qc.invalidateQueries({ queryKey: ["care-jobs", host.id] });
    },
  });
  const busy = op.isPending,
    data = query.data,
    d = data?.docker,
    body = { color: c.foregroundMuted, fontSize: 14, lineHeight: 21 },
    title = { color: c.foreground, fontSize: 18, fontWeight: "600" as const },
    card = {
      backgroundColor: c.surface1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: layout.compact ? 16 : 22,
      gap: 16,
    };
  useEffect(() => {
    setSearch("");
    setSelected([]);
  }, [tab, dockerTab, host.id]);
  const ask = (requests: Request[]) => {
    op.reset();
    setPlan(null);
    setDialog("confirm");
    op.mutate(async () => {
      setPlan(await preview({ requests }));
    });
  };
  const note = (children: ReactNode) => <Text style={body}>{children}</Text>;
  const actions = (children: ReactNode) => (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
    >
      {children}
    </View>
  );
  const empty = (text: string) => (
    <Text style={{ ...body, paddingVertical: 16 }}>{text}</Text>
  );
  const filtered = (s: string) =>
    s.toLowerCase().includes(search.toLowerCase());
  const candidates = data?.analysis.candidates ?? [];
  const cleanup = candidates.filter(
    (x) => (showProtected || x.eligible) && filtered(x.title),
  );
  const jobs = jobQuery.data?.jobs ?? data?.jobs ?? [];
  const checkbox = (r: Candidate) => (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={`${r.title} 선택`}
      accessibilityState={{
        checked: selected.includes(r.id),
        disabled: !r.eligible,
      }}
      aria-checked={selected.includes(r.id)}
      disabled={!r.eligible || busy}
      onPress={() =>
        setSelected((xs) =>
          xs.includes(r.id) ? xs.filter((x) => x !== r.id) : [...xs, r.id],
        )
      }
      style={{
        minHeight: 44,
        minWidth: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: r.eligible ? 1 : 0.35,
      }}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderWidth: 1,
          borderColor: selected.includes(r.id) ? c.accent : c.border,
          backgroundColor: selected.includes(r.id) ? c.accent : "transparent",
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected.includes(r.id) && (
          <Icon name="Check" size={14} color={c.accentForeground} />
        )}
      </View>
    </Pressable>
  );
  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: c.surface0 }}
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: 22,
          maxWidth: 1140,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 12,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text accessibilityRole="header" style={{ ...title, fontSize: 24 }}>
            시스템 관리
          </Text>
          {actions(
            <>
              <Button
                colors={c}
                primary
                icon="WandSparkles"
                disabled={
                  busy ||
                  data?.jobs.some((j) =>
                    ["waiting", "running"].includes(j.status),
                  )
                }
                onPress={() => {
                  op.reset();
                  setPlan(null);
                  setDialog("confirm");
                  op.mutate(async () => {
                    setPlan(await autoClean({}));
                  });
                }}
              >
                자동 정리
              </Button>
              <Button
                colors={c}
                icon="History"
                onPress={() => {
                  op.reset();
                  setDialog("history");
                  void jobQuery.refetch();
                }}
              >
                작업 이력
              </Button>
              <Button
                colors={c}
                icon="Settings"
                onPress={() => {
                  op.reset();
                  setDraft(data?.settings ?? null);
                  setSettingsText({});
                  setDialog("settings");
                }}
              >
                설정
              </Button>
            </>,
          )}
        </View>
        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 20,
            borderBottomWidth: 1,
            borderColor: c.border,
          }}
        >
          {Object.entries(tabs).map(([k, label]) => (
            <Pressable
              key={k}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === k }}
              aria-selected={tab === k}
              onPress={() => setTab(k as keyof typeof tabs)}
              style={{
                minHeight: 48,
                justifyContent: "center",
                borderBottomWidth: 2,
                borderBottomColor: tab === k ? c.accent : "transparent",
              }}
            >
              <Text
                style={{
                  color: tab === k ? c.foreground : c.foregroundMuted,
                  fontSize: 16,
                  fontWeight: "600",
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        {(query.isLoading || busy) && (
          <ActivityIndicator
            accessibilityLabel="시스템 정보 처리 중"
            color={c.accent}
          />
        )}
        {(query.error || op.error) && (
          <Text
            accessibilityRole="alert"
            style={{ ...body, color: c.statusDanger }}
          >
            {errorText((op.error ?? query.error)!)}
          </Text>
        )}
        {notice && (
          <Text accessibilityLiveRegion="polite" style={body}>
            {notice}
          </Text>
        )}
        {data && tab === "summary" && (
          <>
            <View style={card}>
              <Text style={title}>저장 공간</Text>
              {data.disks.map((disk) => (
                <View key={disk.device} style={{ gap: 8 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <Text style={{ color: c.foreground, fontSize: 16 }}>
                      {disk.mount}
                    </Text>
                    {note(
                      `${bytes(disk.used)} 사용 · ${bytes(disk.available)} 여유 / ${bytes(disk.total)}`,
                    )}
                  </View>
                  <View
                    accessibilityRole="progressbar"
                    accessibilityLabel={`${disk.mount} 디스크 사용률`}
                    accessibilityValue={{
                      min: 0,
                      max: 100,
                      now: disk.total ? (disk.used / disk.total) * 100 : 0,
                    }}
                    style={{
                      height: 7,
                      borderRadius: 4,
                      backgroundColor: c.surface2,
                      overflow: "hidden",
                    }}
                  >
                    <View
                      style={{
                        height: 7,
                        width: `${Math.min(100, disk.total ? (disk.used / disk.total) * 100 : 0)}%`,
                        backgroundColor:
                          disk.available / disk.total < 0.1
                            ? c.statusDanger
                            : c.accent,
                      }}
                    />
                  </View>
                </View>
              ))}
            </View>
            <View style={card}>
              <Text style={title}>리소스</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
                {[
                  { label: "전체 CPU", value: pct(data.cpu) },
                  {
                    label: "사용 가능한 메모리",
                    value: `${bytes(data.memory.available)} / ${bytes(data.memory.total)}`,
                  },
                  {
                    label: "스왑 사용",
                    value: `${bytes(data.memory.swapUsed)} / ${bytes(data.memory.swapTotal)}`,
                  },
                ].map((x) => (
                  <View
                    key={x.label}
                    style={{ flexBasis: 220, flexGrow: 1, gap: 6 }}
                  >
                    {note(x.label)}
                    <Text
                      style={{
                        color: c.foreground,
                        fontSize: 22,
                        fontWeight: "600",
                      }}
                    >
                      {x.value}
                    </Text>
                  </View>
                ))}
              </View>
              {data.memory.swapTotal > 0 &&
                data.memory.swapUsed / data.memory.swapTotal > 0.9 &&
                note(
                  "스왑 사용이 높습니다. 현재 프로그램별 메모리와 응답 상태를 확인하세요.",
                )}
              {actions(
                <Button colors={c} onPress={() => setTab("resources")}>
                  프로그램 사용량 보기
                </Button>,
              )}
            </View>
            <View style={card}>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <Text style={title}>정리 분석</Text>
                {note(scanLabel[data.analysis.status])}
              </View>
              {note(
                "분석은 자동으로 수행합니다. 선택한 항목의 영향을 확인한 뒤 승인해야 정리가 실행됩니다.",
              )}
              {note(
                "자동 정리는 오래된 캐시·미사용 Docker 항목을 모아 처리합니다. 프로그램 정상 종료는 리소스 탭에서 직접 선택합니다.",
              )}
              {note(
                `${candidates.filter((x) => x.eligible).length}개 검토 가능 · ${candidates.filter((x) => !x.eligible).length}개 보호`,
              )}
              {actions(
                <>
                  <Button colors={c} onPress={() => setTab("clean")}>
                    정리 항목 보기
                  </Button>
                  <Button
                    colors={c}
                    disabled={busy}
                    onPress={() =>
                      op.mutate(() =>
                        scan({ cancel: data.analysis.status === "running" }),
                      )
                    }
                  >
                    {data.analysis.status === "running"
                      ? "분석 취소"
                      : "다시 분석"}
                  </Button>
                </>,
              )}
            </View>
            <View style={card}>
              <Text style={title}>Docker</Text>
              {d?.available ? (
                <>
                  <View
                    style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}
                  >
                    {note(
                      `컨테이너 ${d.containers.length}개 · 실행 중 ${d.containers.filter((x) => x.state === "running").length}개`,
                    )}
                    {note(`이미지 저장 공간 ${bytes(d.usage.imageBytes)}`)}
                    {note(
                      `볼륨 ${bytes(d.usage.volumeBytes)} · 빌드 캐시 ${bytes(d.usage.buildBytes)}`,
                    )}
                  </View>
                  {actions(
                    <Button colors={c} onPress={() => setTab("docker")}>
                      Docker 관리
                    </Button>,
                  )}
                </>
              ) : (
                note(d?.error ?? "Docker 정보를 준비하고 있습니다.")
              )}
            </View>
          </>
        )}
        {data && tab === "clean" && (
          <>
            <View style={card}>
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <Text style={title}>승인 후 정리</Text>
                {actions(
                  <Button
                    colors={c}
                    disabled={busy}
                    onPress={() =>
                      op.mutate(() =>
                        scan({ cancel: data.analysis.status === "running" }),
                      )
                    }
                  >
                    {data.analysis.status === "running"
                      ? "분석 취소"
                      : "다시 분석"}
                  </Button>,
                )}
              </View>
              {note(
                `${scanLabel[data.analysis.status]}${data.analysis.finishedAt ? " · " + date(data.analysis.finishedAt) : ""}`,
              )}
              <TextInput
                accessibilityLabel="정리 항목 검색"
                placeholder="정리 항목 검색"
                placeholderTextColor={c.foregroundMuted}
                value={search}
                onChangeText={setSearch}
                style={{
                  color: c.foreground,
                  backgroundColor: c.surface2,
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 16,
                }}
              />
              <SettingsSwitch
                label="보호 항목도 보기"
                value={showProtected}
                onValueChange={setShowProtected}
              />
              {selected.length > 0 &&
                actions(
                  <Button
                    colors={c}
                    primary
                    disabled={busy}
                    onPress={() =>
                      ask(
                        candidates
                          .filter((x) => selected.includes(x.id))
                          .map(candidateRequest),
                      )
                    }
                  >
                    {selected.length}개 변경 내용 확인
                  </Button>,
                )}
              {cleanup.length === 0
                ? empty(
                    data.analysis.status === "running"
                      ? "분석이 끝나면 결과가 표시됩니다."
                      : "현재 표시할 정리 후보가 없습니다.",
                  )
                : cleanup.map((r) => (
                    <View
                      key={r.id}
                      style={{
                        flexDirection: "row",
                        gap: 10,
                        paddingVertical: 14,
                        borderTopWidth: 1,
                        borderColor: c.border,
                      }}
                    >
                      {checkbox(r)}
                      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
                        <View
                          style={{
                            flexDirection: "row",
                            flexWrap: "wrap",
                            justifyContent: "space-between",
                            gap: 6,
                          }}
                        >
                          <Text
                            style={{
                              color: c.foreground,
                              fontSize: 16,
                              fontWeight: "500",
                            }}
                          >
                            {r.title}
                          </Text>
                          {note(bytes(r.bytes))}
                        </View>
                        {note(r.reason)}
                        {note(r.impact)}
                        {r.admin &&
                          note(
                            data.helper.installed
                              ? "관리자 승인 필요"
                              : "관리자 도우미 설치 필요",
                          )}
                      </View>
                    </View>
                  ))}
            </View>
            <View style={card}>
              <Text style={title}>파일시스템 용량 분석</Text>
              {note(
                "파일 내용은 읽지 않습니다. 개인 파일과 Docker 데이터는 용량 조회만 제공합니다.",
              )}
              {data.analysis.areas.map((a) => (
                <View
                  key={a.path}
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    gap: 8,
                    paddingVertical: 8,
                  }}
                >
                  <Text
                    selectable
                    style={{ color: c.foreground, fontSize: 14 }}
                  >
                    {a.path}
                  </Text>
                  {note(
                    a.status === "unavailable"
                      ? "미조회"
                      : `${bytes(a.bytes)}${a.status === "partial" ? " · 일부 조회" : ""}`,
                  )}
                </View>
              ))}
            </View>
          </>
        )}
        {data && tab === "resources" && (
          <View style={card}>
            <Text style={title}>프로그램별 사용량</Text>
            {note(
              "CPU는 전체 코어 대비 사용률입니다. 메모리는 프로그램과 하위 프로세스의 RSS 합계입니다.",
            )}
            {data.warnings.map((w) => (
              <Text key={w} style={body}>
                {w}
              </Text>
            ))}
            <TextInput
              accessibilityLabel="프로그램 검색"
              placeholder="프로그램·서비스 이름 검색"
              placeholderTextColor={c.foregroundMuted}
              value={search}
              onChangeText={setSearch}
              style={{
                color: c.foreground,
                backgroundColor: c.surface2,
                padding: 12,
                borderRadius: 8,
                fontSize: 16,
              }}
            />
            {note(
              `${data.programs.length}개 프로그램 · 메모리 사용량 순서로 최대 150개를 표시합니다. 검색하면 전체 목록에서 찾습니다.`,
            )}
            {data.programs
              .filter((p) => filtered(p.name + " " + (p.service ?? "")))
              .slice(0, 150)
              .map((p) => (
                <View
                  key={p.id}
                  style={{
                    paddingVertical: 14,
                    borderTopWidth: 1,
                    borderColor: c.border,
                    gap: 8,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <View style={{ flex: 1, minWidth: 180, gap: 5 }}>
                      <Text
                        style={{
                          color: c.foreground,
                          fontSize: 16,
                          fontWeight: "500",
                        }}
                      >
                        {p.name}
                      </Text>
                      {note(
                        `${bytes(p.rss)} · CPU ${pct(p.cpu)} · ${p.pids.length}개 프로세스 · ${Math.floor(p.ageSeconds / 60)}분`,
                      )}
                      {p.service && note("사용자 서비스 · " + p.service)}
                    </View>
                    <Button
                      colors={c}
                      disabled={p.protected || busy}
                      danger={!p.protected}
                      onPress={() =>
                        ask([{ action: "process-stop", target: p.id }])
                      }
                    >
                      {p.protected ? "보호 대상" : "정상 종료"}
                    </Button>
                  </View>
                  {note(p.reason)}
                  {p.container &&
                    actions(
                      <Button
                        colors={c}
                        onPress={() => {
                          setSearch("");
                          setDockerTab("containers");
                          setTab("docker");
                        }}
                      >
                        Docker에서 보기
                      </Button>,
                    )}
                </View>
              ))}
          </View>
        )}
        {data && tab === "docker" && (
          <>
            <View style={card}>
              <Text style={title}>로컬 Docker</Text>
              {note(
                d?.available
                  ? `${d.socket} · 기존 호스트 권한 사용`
                  : (d?.error ?? "Docker 조회 중…"),
              )}
              <View
                accessibilityRole="tablist"
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}
              >
                {Object.entries(dockerTabs).map(([k, label]) => (
                  <Button
                    key={k}
                    colors={c}
                    primary={dockerTab === k}
                    onPress={() => setDockerTab(k as keyof typeof dockerTabs)}
                  >
                    {label}
                  </Button>
                ))}
              </View>
              <TextInput
                accessibilityLabel="Docker 항목 검색"
                placeholder="이름·이미지 검색"
                placeholderTextColor={c.foregroundMuted}
                value={search}
                onChangeText={setSearch}
                style={{
                  color: c.foreground,
                  backgroundColor: c.surface2,
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 16,
                }}
              />
            </View>
            {d?.available && (
              <View style={card}>
                {dockerTab === "containers" && (
                  <>
                    {note(
                      "CPU 100%는 논리 코어 하나의 사용량입니다. 컨테이너 삭제 기능은 제공하지 않습니다.",
                    )}
                    {d.containers
                      .filter((x) => filtered(x.name + " " + x.image))
                      .map((x) => (
                        <View
                          key={x.id}
                          style={{
                            paddingVertical: 16,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                            gap: 10,
                          }}
                        >
                          <Text style={title}>{x.name}</Text>
                          {note(
                            `${x.status} · ${x.project ?? "개별 컨테이너"}`,
                          )}
                          <Text selectable style={body}>
                            {x.image}
                          </Text>
                          {note(
                            `CPU ${pct(x.cpu)} · 메모리 ${bytes(x.memory)} · 쓰기 레이어 ${bytes(x.writableBytes)}`,
                          )}
                          {note(
                            `볼륨 ${x.volumes.length}개 · 네트워크 ${x.networks.length}개`,
                          )}
                          {actions(
                            <>
                              <Button
                                colors={c}
                                disabled={busy}
                                onPress={() =>
                                  ask([
                                    {
                                      action:
                                        x.state === "running"
                                          ? "container-stop"
                                          : "container-start",
                                      target: x.id,
                                    },
                                  ])
                                }
                              >
                                {x.state === "running" ? "중지" : "시작"}
                              </Button>
                              <Button
                                colors={c}
                                disabled={busy || x.state !== "running"}
                                onPress={() =>
                                  ask([
                                    {
                                      action: "container-restart",
                                      target: x.id,
                                    },
                                  ])
                                }
                              >
                                재시작
                              </Button>
                              <Button
                                colors={c}
                                icon="Logs"
                                onPress={() => {
                                  setLogId(x.id);
                                  setDialog("logs");
                                }}
                              >
                                로그
                              </Button>
                            </>,
                          )}
                        </View>
                      ))}
                  </>
                )}
                {dockerTab === "images" && (
                  <>
                    {note(
                      "이미지 크기는 공유 레이어를 포함합니다. 개별 크기를 더해 전체 저장 공간으로 표시하지 않습니다.",
                    )}
                    {d.images
                      .filter((x) => filtered(x.tags.join(" ") + " " + x.id))
                      .map((x) => (
                        <View
                          key={x.id}
                          style={{
                            paddingVertical: 16,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                            gap: 8,
                          }}
                        >
                          <Text
                            selectable
                            style={{
                              color: c.foreground,
                              fontSize: 16,
                              fontWeight: "500",
                            }}
                          >
                            {x.tags.join(", ") || x.id.slice(0, 24)}
                          </Text>
                          {note(
                            `${bytes(x.size)} · 고유 레이어 ${bytes(x.uniqueSize)}`,
                          )}
                          {note(x.reason)}
                          {x.references.length > 0 &&
                            note("연결: " + x.references.join(", "))}
                          {actions(
                            <Button
                              colors={c}
                              danger
                              disabled={busy || x.protected}
                              onPress={() =>
                                ask([{ action: "image-remove", target: x.id }])
                              }
                            >
                              {x.protected ? "보호 대상" : "변경 내용 확인"}
                            </Button>,
                          )}
                        </View>
                      ))}
                  </>
                )}
                {dockerTab === "volumes" && (
                  <>
                    {note(
                      "미연결 볼륨에도 데이터가 남아 있습니다. 모든 볼륨은 삭제 대상에서 제외합니다.",
                    )}
                    {d.volumes
                      .filter((x) => filtered(x.name))
                      .map((x) => (
                        <View
                          key={x.name}
                          style={{
                            paddingVertical: 14,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                            gap: 6,
                          }}
                        >
                          <Text
                            selectable
                            style={{ color: c.foreground, fontSize: 16 }}
                          >
                            {x.name}
                          </Text>
                          {note(
                            `${x.driver} · ${bytes(x.bytes)} · 데이터 보호`,
                          )}
                          {note(
                            x.references.length
                              ? "연결: " + x.references.join(", ")
                              : "현재 연결 없음 · 데이터는 보존됩니다.",
                          )}
                        </View>
                      ))}
                  </>
                )}
                {dockerTab === "networks" && (
                  <>
                    {d.networks
                      .filter((x) => filtered(x.name))
                      .map((x) => (
                        <View
                          key={x.id}
                          style={{
                            paddingVertical: 14,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                            gap: 8,
                          }}
                        >
                          <Text style={{ color: c.foreground, fontSize: 16 }}>
                            {x.name}
                          </Text>
                          {note(`${x.driver} · ${x.reason}`)}
                          {note(x.references.join(", "))}
                          {actions(
                            <Button
                              colors={c}
                              danger
                              disabled={busy || x.protected}
                              onPress={() =>
                                ask([
                                  { action: "network-remove", target: x.id },
                                ])
                              }
                            >
                              {x.protected ? "보호 대상" : "변경 내용 확인"}
                            </Button>,
                          )}
                        </View>
                      ))}
                  </>
                )}
                {dockerTab === "stacks" && (
                  <>
                    {note(
                      "기존 컨테이너의 시작·중지·재시작만 지원합니다. 새 배포나 데이터 삭제는 수행하지 않습니다.",
                    )}
                    {d.stacks
                      .filter((x) => filtered(x.name))
                      .map((x) => (
                        <View
                          key={x.name}
                          style={{
                            paddingVertical: 14,
                            borderBottomWidth: 1,
                            borderColor: c.border,
                            gap: 10,
                          }}
                        >
                          <Text style={title}>{x.name}</Text>
                          {note(
                            `${x.containers.length}개 컨테이너 · ${x.readable ? "Compose 참조 확인" : "설정 미조회"}`,
                          )}
                          {x.files.map((f) => (
                            <Text key={f} selectable style={body}>
                              {f}
                            </Text>
                          ))}
                          {actions(
                            <>
                              {(["start", "stop", "restart"] as const).map(
                                (a) => (
                                  <Button
                                    key={a}
                                    colors={c}
                                    disabled={
                                      busy ||
                                      !x.readable ||
                                      !x.containers.length
                                    }
                                    onPress={() =>
                                      ask([
                                        {
                                          action: ("compose-" +
                                            a) as Request["action"],
                                          target: x.name,
                                        },
                                      ])
                                    }
                                  >
                                    {a === "start"
                                      ? "시작"
                                      : a === "stop"
                                        ? "중지"
                                        : "재시작"}
                                  </Button>
                                ),
                              )}
                            </>,
                          )}
                        </View>
                      ))}
                  </>
                )}
              </View>
            )}
            {d?.warnings.map((w) => (
              <Text key={w} style={body}>
                {w}
              </Text>
            ))}
          </>
        )}
        {data?.analysis.warnings.map((w) => (
          <Text key={w} style={body}>
            {w}
          </Text>
        ))}
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c.border,
            paddingTop: 16,
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          {note(data ? "확인 " + date(data.sampledAt) : "정보 조회 중")}
          {actions(
            <Button
              colors={c}
              icon="RefreshCw"
              disabled={query.isFetching || busy}
              onPress={() => {
                op.reset();
                void query.refetch();
              }}
            >
              새로고침
            </Button>,
          )}
        </View>
      </ScrollView>
      <Modal
        title="변경 내용 확인"
        open={dialog === "confirm"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content
          scrollable={false}
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          {busy && !plan && (
            <ActivityIndicator
              accessibilityLabel="변경 내용 준비 중"
              color={c.accent}
            />
          )}
          <SheetScrollView
            style={{ maxHeight: layout.compact ? 340 : 460 }}
            contentContainerStyle={{ gap: 16 }}
          >
            {plan?.steps.map((s, i) => (
              <View
                key={i}
                style={{
                  gap: 6,
                  paddingBottom: 12,
                  borderBottomWidth: 1,
                  borderColor: c.border,
                }}
              >
                <Text style={title}>{s.title}</Text>
                {note(s.impact)}
                {note(
                  s.bytes !== null
                    ? "대상 용량 " + bytes(s.bytes)
                    : "정리 또는 종료 전 상태를 다시 검사합니다.",
                )}
                {s.admin && note("Ubuntu 호스트에서 관리자 인증이 필요합니다.")}
              </View>
            ))}
            {plan?.excluded.map((x, i) => (
              <Text key={i} style={{ ...body, color: c.statusWarning }}>
                보호·제외: {x.reason}
              </Text>
            ))}
          </SheetScrollView>
          {op.error && (
            <Text
              accessibilityRole="alert"
              style={{ ...body, color: c.statusDanger }}
            >
              {errorText(op.error)}
            </Text>
          )}
          {plan &&
            note(
              "미리보기는 2분간 유효합니다. 상태가 달라진 대상은 실행하지 않습니다.",
            )}
          {actions(
            <>
              <Button
                colors={c}
                primary
                disabled={busy || !plan?.steps.length}
                onPress={() =>
                  op.mutate(async () => {
                    await execute({ id: plan!.id, confirmed: true });
                    setSelected([]);
                    setDialog(null);
                    setNotice(
                      "승인한 작업을 등록했습니다. 작업 이력에서 진행 상태를 확인하세요.",
                    );
                  })
                }
              >
                확인 후 실행
              </Button>
              <Button
                colors={c}
                disabled={busy}
                onPress={() => setDialog(null)}
              >
                취소
              </Button>
            </>,
          )}
        </Modal.Content>
      </Modal>
      <Modal
        title="작업 이력"
        open={dialog === "history"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content
          scrollable={false}
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          {(jobQuery.error || op.error) && (
            <Text style={{ ...body, color: c.statusDanger }}>
              {errorText((op.error ?? jobQuery.error)!)}
            </Text>
          )}
          <SheetScrollView
            style={{ maxHeight: layout.compact ? 360 : 460 }}
            contentContainerStyle={{ gap: 14 }}
          >
            {jobs.length === 0
              ? empty("아직 실행한 작업이 없습니다.")
              : [...jobs].reverse().map((j) => (
                  <View key={j.id} style={card}>
                    <Text style={title}>{jobLabel[j.status]}</Text>
                    {note(date(j.createdAt))}
                    {j.reclaimedBytes !== null &&
                      note(
                        "실행 전후 여유 공간 증가 " + bytes(j.reclaimedBytes),
                      )}
                    {j.steps.map((s, i) => (
                      <View
                        key={i}
                        style={{
                          gap: 5,
                          paddingTop: 10,
                          borderTopWidth: 1,
                          borderColor: c.border,
                        }}
                      >
                        <Text style={{ color: c.foreground, fontSize: 15 }}>
                          {s.title} · {jobLabel[s.status]}
                        </Text>
                        {s.message && note(s.message)}
                      </View>
                    ))}
                    {["waiting", "running"].includes(j.status) &&
                      actions(
                        <Button
                          colors={c}
                          disabled={busy}
                          onPress={() =>
                            op.mutate(() => fetchJobs({ cancel: j.id }))
                          }
                        >
                          남은 작업 취소
                        </Button>,
                      )}
                  </View>
                ))}
          </SheetScrollView>
        </Modal.Content>
      </Modal>
      <Modal
        title="시스템 관리 설정"
        open={dialog === "settings"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content>
          {draft && (
            <>
              <SettingsSelect
                label="용량 분석 주기"
                value={String(draft.analysisMinutes)}
                options={[
                  { label: "30분", value: "30" },
                  { label: "1시간", value: "60" },
                  { label: "6시간", value: "360" },
                  { label: "하루", value: "1440" },
                ]}
                onValueChange={(v) =>
                  setDraft({ ...draft, analysisMinutes: Number(v) })
                }
              />
              {note(
                "분석만 자동으로 수행하며 정리·프로그램 종료는 항상 직접 승인합니다.",
              )}
              {(
                [
                  { key: "composeFiles", label: "추가 Compose 파일 경로" },
                  {
                    key: "protectedImages",
                    label: "보호할 이미지 태그 또는 ID",
                  },
                  { key: "protectedNetworks", label: "보호할 네트워크 이름" },
                  {
                    key: "protectedPrograms",
                    label: "보호할 프로그램·사용자 서비스 이름",
                  },
                  {
                    key: "protectedContainers",
                    label: "보호할 컨테이너 이름 또는 ID",
                  },
                ] as const
              ).map((f) => (
                <View key={f.key} style={{ gap: 6 }}>
                  {note(f.label)}
                  <TextInput
                    accessibilityLabel={f.label}
                    placeholder="한 줄에 하나씩 입력"
                    placeholderTextColor={c.foregroundMuted}
                    multiline
                    value={settingsText[f.key] ?? draft[f.key].join("\n")}
                    onChangeText={(s) =>
                      setSettingsText((xs) => ({ ...xs, [f.key]: s }))
                    }
                    style={{
                      fontSize: 16,
                      color: c.foreground,
                      backgroundColor: c.surface2,
                      padding: 12,
                      borderRadius: 8,
                      minHeight: 70,
                    }}
                  />
                </View>
              ))}
              <Button
                colors={c}
                primary
                disabled={busy}
                onPress={() =>
                  op.mutate(async () => {
                    await settingsRpcCall({
                      settings: {
                        ...draft,
                        ...Object.fromEntries(
                          Object.entries(settingsText).map(([k, s]) => [
                            k,
                            s
                              .split("\n")
                              .map((x) => x.trim())
                              .filter(Boolean),
                          ]),
                        ),
                      },
                    });
                    setNotice("설정을 저장했습니다.");
                    setDialog(null);
                  })
                }
              >
                설정 저장
              </Button>
            </>
          )}
          {note(data?.helper.message ?? "관리자 도우미 상태 조회 중")}
          {!data?.helper.installed && (
            <Button
              colors={c}
              disabled={busy}
              onPress={() =>
                op.mutate(async () => {
                  const r = await setup({ confirmed: true });
                  setNotice(r.message);
                })
              }
            >
              Ubuntu에서 관리자 도우미 설치 승인
            </Button>
          )}
          {op.error && (
            <Text style={{ ...body, color: c.statusDanger }}>
              {errorText(op.error)}
            </Text>
          )}
        </Modal.Content>
      </Modal>
      <Modal
        title="컨테이너 로그"
        open={dialog === "logs"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <Modal.Content>
          {logQuery.isFetching && (
            <ActivityIndicator
              accessibilityLabel="로그 조회 중"
              color={c.accent}
            />
          )}
          <Text style={body}>
            최근 100줄만 조회하며 알려진 인증 정보를 숨깁니다. 로그는 저장하지
            않습니다.
          </Text>
          {logQuery.error && (
            <Text style={{ ...body, color: c.statusDanger }}>
              {errorText(logQuery.error)}
            </Text>
          )}
          <Text
            selectable
            style={{
              color: c.foreground,
              fontSize: 13,
              fontFamily: "monospace",
              lineHeight: 20,
            }}
          >
            {logQuery.data?.text || "표시할 로그가 없습니다."}
          </Text>
          {logQuery.data?.truncated &&
            note("표시 크기 제한으로 앞부분을 생략했습니다.")}
        </Modal.Content>
      </Modal>
    </>
  );
}
