import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Icon,
  Modal,
  TextInput,
  ScrollView as SheetScrollView,
} from "@getpaseo/plugin/client/react-native";
import { SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import {
  harnessLabels,
  listSessions,
  type Harness,
  type Snapshot,
} from "../shared/accounts.js";
import {
  inventoryExtensions,
  commonExtensions,
  previewExtensions,
  applyExtensions,
  mutateExtension,
  extensionDetails,
  extensionJobs,
  type Target,
  type Kind,
  type ExtensionItem,
} from "../shared/extensions.js";
import { Button, type Colors } from "./ui.js";
import { serviceLogos } from "./branding.js";
const kinds: Record<Kind, string> = {
  plugin: "플러그인",
  skill: "스킬",
  marketplace: "마켓플레이스",
  mcp: "MCP 연결",
};
const actions: Record<string, string> = {
  add: "추가",
  update: "업데이트",
  remove: "삭제",
  enable: "활성화",
  disable: "비활성화",
  configure: "설정 변경",
  skip: "유지",
  conflict: "다른 구성",
  restore: "백업 복원",
  repair: "복구",
};
const statuses: Record<string, string> = {
  pending: "준비 중",
  waiting: "작업이 끝나면 적용",
  running: "적용 중",
  done: "완료",
  error: "확인 필요",
  canceled: "취소됨",
  approval: "명령 승인 필요",
  skipped: "유지",
};
const message = (e: Error) => {
  const n = e.message.search(/[가-힣]/);
  return n < 0
    ? "연결 상태를 확인하고 다시 시도하세요."
    : e.message.slice(n).split(" requestType=")[0];
};
function Check({
  label,
  checked,
  onPress,
  colors,
  showLabel = true,
}: {
  label: string;
  checked: boolean;
  onPress: () => void;
  colors: Colors;
  showLabel?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      aria-checked={checked}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        minWidth: 44,
        justifyContent: showLabel ? undefined : "center",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? colors.accent : colors.border,
          backgroundColor: checked ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {checked && (
          <Icon name="Check" size={14} color={colors.accentForeground} />
        )}
      </View>
      {showLabel && (
        <Text style={{ color: colors.foreground, fontSize: 14, flexShrink: 1 }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
export function ExtensionsPanel({
  theme,
  layout,
  host,
  accounts,
}: Pick<PluginSurfaceProps, "theme" | "layout" | "host"> & {
  accounts: Snapshot;
}) {
  const c = theme.colors,
    qc = useQueryClient();
  const inventory = useRpc(inventoryExtensions),
    save = useRpc(commonExtensions),
    preview = useRpc(previewExtensions),
    apply = useRpc(applyExtensions),
    mutate = useRpc(mutateExtension),
    details = useRpc(extensionDetails),
    jobsRpc = useRpc(extensionJobs),
    sessions = useRpc(listSessions);
  const [harness, setHarness] = useState<Harness>("claude"),
    [accountId, setAccountId] = useState<string | null>(null),
    [scope, setScope] = useState<Target["scope"]>("user"),
    [sessionId, setSessionId] = useState<string | null>(null);
  const [common, setCommon] = useState(false),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [advanced, setAdvanced] = useState(false);
  const [dialog, setDialog] = useState<
      "add" | "apply" | "detail" | "settings" | null
    >(null),
    [item, setItem] = useState<ExtensionItem | null>(null),
    [remove, setRemove] = useState(false),
    [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<Kind>("plugin"),
    [name, setName] = useState(""),
    [value, setValue] = useState(""),
    [targets, setTargets] = useState<string[]>([]),
    [replacements, setReplacements] = useState<string[]>([]);
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof preview>> | null>(
      null,
    ),
    [notice, setNotice] = useState("");
  const target: Target = { harness, accountId, scope, sessionId };
  const rows = [
    {
      id: null,
      label: "시스템 계정",
      status: accounts.systemAccounts.find((x) => x.harness === harness)
        ?.status,
    },
    ...accounts.accounts.filter((x) => x.harness === harness),
  ];
  const label = (id: string | null) =>
    rows.find((r) => r.id === id)?.label ?? "삭제된 계정";
  const key = ["extensions", host.id, target];
  const query = useQuery({
    queryKey: key,
    queryFn: () => inventory(target),
    enabled: scope === "user" || !!sessionId,
    staleTime: 15000,
    retry: false,
  });
  const jobs = useQuery({
    queryKey: ["extension-jobs", host.id],
    queryFn: () => jobsRpc({}),
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => ["waiting", "running"].includes(j.status))
        ? 2000
        : 10000,
  });
  const sessionQuery = useQuery({
    queryKey: ["account-sessions", host.id],
    queryFn: () => sessions({ refresh: false }),
    enabled: advanced && scope !== "user",
  });
  const detailQuery = useQuery({
    queryKey: ["extension-detail", host.id, target, item?.key],
    queryFn: () => details({ target, key: item!.key }),
    enabled: dialog === "detail" && !!item && !common,
    staleTime: 0,
    retry: false,
  });
  const op = useMutation({
    mutationFn: (f: () => Promise<unknown>) => f(),
    onMutate: () => setNotice(""),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["extensions", host.id] });
      void qc.invalidateQueries({ queryKey: ["extension-jobs", host.id] });
    },
    onError: () => {},
  });
  const busy = op.isPending,
    body = { color: c.foregroundMuted, fontSize: 14, lineHeight: 22 };
  useEffect(() => {
    setSelected([]);
    setPlan(null);
    setDialog(null);
    setNotice("");
    op.reset();
  }, [harness, accountId, scope, sessionId, common]);
  useEffect(() => {
    if (accountId && !rows.some((r) => r.id === accountId)) setAccountId(null);
  }, [accounts.accounts]);
  useEffect(() => {
    if (detailQuery.data && !editing) setValue(detailQuery.data.text);
  }, [detailQuery.data, editing]);
  useEffect(() => {
    if (jobs.data?.jobs.length)
      void qc.invalidateQueries({ queryKey: ["extensions", host.id] });
  }, [
    jobs.data?.jobs
      .map(
        (j) => `${j.id}:${j.status}:${j.steps.map((s) => s.status).join(",")}`,
      )
      .join(";"),
  ]);
  const toggle = (xs: string[], x: string) =>
    xs.includes(x) ? xs.filter((v) => v !== x) : [...xs, x];
  const items =
    (common ? query.data?.common : query.data?.items)?.filter(
      (r) =>
        common ||
        ((filter === "all" || r.kind === filter) &&
          r.name.toLowerCase().includes(search.toLowerCase())),
    ) ?? [];
  const missingCommon =
    query.data?.common.filter((r) => r.installation === "missing") ?? [];
  const startApply = () => {
    op.reset();
    setPlan(null);
    setTargets([accountId ?? "system"]);
    setReplacements([]);
    setDialog("apply");
  };
  useEffect(() => {
    setSearch("");
    setFilter("all");
  }, [harness, accountId, scope, sessionId]);
  const act = (action: Parameters<typeof mutate>[0]["action"]) => {
    if (!item) return;
    op.mutate(async () => {
      await mutate({
        target,
        kind: item.kind,
        name: item.name,
        action,
        ...(["edit", "configure"].includes(action) ? { value } : {}),
        confirmed: true,
      });
      setDialog(null);
      setNotice("변경 작업을 등록했습니다.");
    });
  };
  const currentJobs = jobs.data?.jobs ?? query.data?.jobs ?? [];
  const relevant = currentJobs
    .filter(
      (j) =>
        j.steps.some((s) => s.target.harness === harness) &&
        j.status !== "canceled" &&
        j.steps.some((s) => s.action !== "skip"),
    )
    .slice(-3)
    .reverse();
  return (
    <View style={{ gap: 24 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {(["codex", "claude"] as const).map((h) => (
          <Pressable
            key={h}
            accessibilityRole="button"
            disabled={busy}
            accessibilityState={{ selected: h === harness }}
            onPress={() => {
              setHarness(h);
              setAccountId(null);
              setScope("user");
              setSessionId(null);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              minHeight: 56,
              paddingHorizontal: 14,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: h === harness ? c.accent : c.border,
              backgroundColor: pressed ? c.surface2 : c.surface1,
            })}
          >
            <Image
              source={{ uri: serviceLogos[h] }}
              style={{ width: 30, height: 30 }}
              resizeMode="contain"
            />
            <Text
              style={{ color: c.foreground, fontWeight: "600", fontSize: 17 }}
            >
              {harnessLabels[h]}
            </Text>
          </Pressable>
        ))}
      </View>
      <SettingsSelect
        label="관리할 계정"
        value={accountId ?? "system"}
        options={rows.map((r) => ({
          value: r.id ?? "system",
          label: `${r.label}${r.status === "authenticating" ? " · 로그인 중" : ""}`,
        }))}
        onValueChange={(v) => setAccountId(v === "system" ? null : v)}
        disabled={busy}
      />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ flexDirection: "row", gap: 20 }}>
          {[false, true].map((v) => (
            <Pressable
              key={String(v)}
              accessibilityRole="tab"
              accessibilityState={{ selected: common === v }}
              aria-selected={common === v}
              onPress={() => setCommon(v)}
              style={{
                minHeight: 44,
                justifyContent: "center",
                borderBottomWidth: 2,
                borderBottomColor: common === v ? c.accent : "transparent",
              }}
            >
              <Text
                style={{
                  color: common === v ? c.foreground : c.foregroundMuted,
                  fontSize: 16,
                  fontWeight: "600",
                }}
              >
                {v ? "공통 구성" : "설치된 항목"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button
          colors={c}
          icon={common ? "CopyPlus" : "Plus"}
          disabled={busy || (common && !query.data?.common.length)}
          onPress={() => {
            op.reset();
            setPlan(null);
            if (common) {
              setTargets([accountId ?? "system"]);
              setReplacements([]);
              setDialog("apply");
            } else {
              setName("");
              setValue("");
              setKind(
                harness === "codex" && scope !== "user" ? "skill" : "plugin",
              );
              setDialog("add");
            }
          }}
        >
          {common ? "계정에 적용" : "추가"}
        </Button>
      </View>
      {common && (
        <Text style={body}>
          이 계정의 실제 설치 상태를 함께 표시합니다. 공통 구성 저장 후 다른
          계정에는 ‘계정에 적용’을 눌러 설치하세요.
        </Text>
      )}
      {!common && missingCommon.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={body}>
            이 계정에 아직 설치하지 않은 공통 항목이 {missingCommon.length}개
            있습니다.
          </Text>
          <View style={{ alignItems: "flex-start" }}>
            <Button colors={c} disabled={busy} onPress={startApply}>
              빠진 공통 항목 설치
            </Button>
          </View>
        </View>
      )}
      {!common && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
          }}
        >
          <TextInput
            accessibilityLabel="설치 항목 검색"
            placeholder="항목 검색"
            placeholderTextColor={c.foregroundMuted}
            value={search}
            onChangeText={setSearch}
            style={{
              flexGrow: 1,
              flexBasis: 200,
              color: c.foreground,
              backgroundColor: c.surface1,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 12,
              fontSize: 16,
            }}
          />
          <View style={{ width: 350, maxWidth: "100%" }}>
            <SettingsSelect
              label="종류"
              value={filter}
              options={[
                { value: "all", label: "전체" },
                ...Object.entries(kinds).map(([value, label]) => ({
                  value,
                  label,
                })),
              ]}
              onValueChange={setFilter}
            />
          </View>
        </View>
      )}
      {query.isFetching && (
        <ActivityIndicator
          accessibilityLabel="설치 목록 조회 중"
          color={c.accent}
        />
      )}
      {(query.error || op.error) && (
        <Text
          accessibilityRole="alert"
          style={{ ...body, color: c.statusDanger }}
        >
          {message((op.error ?? query.error)!)}
        </Text>
      )}
      {!!notice && (
        <Text accessibilityLiveRegion="polite" style={body}>
          {notice}
        </Text>
      )}
      {!!selected.length && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 10,
            alignItems: "center",
          }}
        >
          <Text style={body}>{selected.length}개 선택</Text>
          <Button
            colors={c}
            disabled={busy}
            onPress={() =>
              op.mutate(async () => {
                await save({ target, keys: selected, remove: common });
                setSelected([]);
                setNotice(
                  common
                    ? "공통 구성에서 제외했습니다. 설치된 항목은 유지됩니다."
                    : "공통 구성을 저장했습니다. 다른 계정에는 ‘계정에 적용’을 눌러 설치하세요.",
                );
              })
            }
          >
            {common ? "공통 구성에서 제외" : "공통 구성으로 저장"}
          </Button>
          <Button colors={c} onPress={() => setSelected([])}>
            선택 해제
          </Button>
        </View>
      )}
      <View style={{ borderTopWidth: 1, borderColor: c.border }}>
        {items.length === 0 && !query.isFetching && (
          <View style={{ paddingVertical: 32, gap: 8 }}>
            <Text
              style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}
            >
              {common ? "아직 공통 구성이 없습니다" : "표시할 항목이 없습니다"}
            </Text>
            <Text style={body}>
              {common
                ? "설치된 항목에서 함께 사용할 항목을 선택해 저장하세요."
                : "다른 계정을 선택하거나 필요한 항목을 추가하세요."}
            </Text>
          </View>
        )}
        {items.map((r, i) => (
          <View
            key={`${r.key}:${r.scope}:${i}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderColor: c.border,
            }}
          >
            <Check
              showLabel={false}
              label={`${r.name} 선택`}
              checked={selected.includes(r.key)}
              colors={c}
              onPress={() => setSelected(toggle(selected, r.key))}
            />
            <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
              <Text
                selectable
                style={{ color: c.foreground, fontSize: 16, fontWeight: "500" }}
              >
                {r.name}
              </Text>
              <Text style={{ ...body, fontSize: 13 }}>
                {[
                  kinds[r.kind],
                  r.version,
                  r.common && !common ? "공통 구성" : null,
                  common
                    ? r.installation === "missing"
                      ? "이 계정에 미설치"
                      : r.installation === "different"
                        ? "설치됨 · 공통 구성과 다름"
                        : r.installation === "installed" ? "이 계정에 설치됨" : "설치 상태 확인 중"
                    : null,
                  !r.enabled ? "비활성" : null,
                  r.scope === "host"
                    ? "호스트 공통"
                    : r.scope !== scope
                      ? r.scope === "user"
                        ? "계정 범위"
                        : "프로젝트 범위"
                      : null,
                  r.authNeeded ? "인증 값 확인 필요" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            {!common && (
              <Button
                colors={c}
                icon="ChevronRight"
                onPress={() => {
                  op.reset();
                  setItem(r);
                  setValue("");
                  setEditing(false);
                  setRemove(false);
                  setDialog("detail");
                }}
              >
                관리
              </Button>
            )}
          </View>
        ))}
      </View>
      {query.data?.warnings.map((w) => (
        <Text key={w} style={body}>
          {w}
        </Text>
      ))}
      {!!relevant.length && (
        <View style={{ gap: 14 }}>
          <Text
            accessibilityRole="header"
            style={{ color: c.foreground, fontSize: 16, fontWeight: "600" }}
          >
            최근 변경
          </Text>
          {relevant.map((j) => (
            <View
              key={j.id}
              style={{
                gap: 10,
                paddingBottom: 12,
                borderBottomWidth: 1,
                borderColor: c.border,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <Text
                  accessibilityLiveRegion="polite"
                  style={{
                    ...body,
                    color: j.status === "error" ? c.statusDanger : c.foreground,
                  }}
                >
                  {statuses[j.status]} ·{" "}
                  {j.steps.filter((s) => s.status === "done").length}/
                  {j.steps.filter((s) => s.action !== "skip").length}개
                </Text>
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  {["waiting", "approval", "error"].includes(j.status) && (
                    <Button
                      colors={c}
                      disabled={busy}
                      onPress={() => op.mutate(() => jobsRpc({ cancel: j.id }))}
                    >
                      취소
                    </Button>
                  )}
                  {j.status === "error" && (
                    <Button
                      colors={c}
                      disabled={busy}
                      onPress={() => op.mutate(() => jobsRpc({ retry: j.id }))}
                    >
                      재시도
                    </Button>
                  )}
                </View>
              </View>
              {j.steps
                .filter((s) => s.status !== "skipped")
                .map((s, index) => (
                  <View key={index} style={{ gap: 6 }}>
                    <Text style={body}>
                      {label(s.target.accountId)} · {s.name} ·{" "}
                      {actions[s.action]}
                      {s.status !== "done" ? ` · ${statuses[s.status]}` : ""}
                    </Text>
                    {s.message && (
                      <Text
                        style={{
                          ...body,
                          color:
                            s.status === "error"
                              ? c.statusDanger
                              : c.foregroundMuted,
                        }}
                      >
                        {s.message}
                      </Text>
                    )}
                    {s.status === "approval" && s.command && (
                      <>
                        <Text style={body}>
                          설치 소스가 다음 명령을 실행하려고 합니다. 내용을
                          확인한 후 승인하세요.
                        </Text>
                        <Text
                          selectable
                          style={{
                            ...body,
                            fontFamily: "monospace",
                            backgroundColor: c.surface1,
                            padding: 12,
                            borderRadius: 8,
                          }}
                        >
                          {s.command}
                        </Text>
                        <Button
                          colors={c}
                          disabled={busy}
                          onPress={() =>
                            op.mutate(() =>
                              jobsRpc({
                                approve: { id: j.id, hash: s.approvalHash! },
                              }),
                            )
                          }
                        >
                          이 명령 실행 승인
                        </Button>
                      </>
                    )}
                    {["done", "error"].includes(s.status) &&
                      s.backupId &&
                      s.action !== "restore" && (
                        <View style={{ alignItems: "flex-start" }}>
                          <Button
                            colors={c}
                            disabled={busy}
                            onPress={() =>
                              op.mutate(() =>
                                jobsRpc({
                                  restore: {
                                    id: j.id,
                                    index: j.steps.indexOf(s),
                                    confirmed: true,
                                  },
                                }),
                              )
                            }
                          >
                            이전 구성으로 복원
                          </Button>
                        </View>
                      )}
                  </View>
                ))}
            </View>
          ))}
        </View>
      )}
      <View style={{ gap: 14 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button colors={c} onPress={() => setAdvanced(!advanced)}>
            관리 범위{advanced ? " 접기" : ""}
          </Button>
          <Button colors={c} onPress={() => setDialog("settings")}>
            자동 적용 설정
          </Button>
        </View>
        {advanced && (
          <>
            <SettingsSelect
              label="관리 범위"
              value={scope}
              options={[
                { value: "user", label: "이 계정의 전체 프로젝트" },
                { value: "project", label: "선택한 프로젝트" },
                ...(harness === "claude"
                  ? [{ value: "local", label: "선택한 프로젝트 · 나만 사용" }]
                  : []),
              ]}
              onValueChange={(v) => setScope(v as Target["scope"])}
            />
            {scope !== "user" && (
              <>
                <SettingsSelect
                  label="프로젝트 세션"
                  value={sessionId ?? ""}
                  options={[
                    { value: "", label: "세션 선택" },
                    ...(
                      sessionQuery.data?.sessions.filter(
                        (s) => s.harness === harness,
                      ) ?? []
                    ).map((s) => ({
                      value: s.id,
                      label: `${s.title} · ${s.cwd}`,
                    })),
                  ]}
                  onValueChange={(v) => setSessionId(v || null)}
                />
                <Text style={body}>
                  {harness === "codex"
                    ? "프로젝트 범위에서는 스킬을 관리합니다. 플러그인·마켓플레이스·MCP는 계정 범위에서 관리하세요."
                    : "프로젝트 구성은 해당 폴더에 연결된 다른 계정에도 영향을 줍니다."}
                </Text>
                {sessionQuery.error && (
                  <Text style={{ ...body, color: c.statusDanger }}>
                    {message(sessionQuery.error)}
                  </Text>
                )}
              </>
            )}
          </>
        )}
      </View>
      <View
        style={{
          paddingTop: 16,
          borderTopWidth: 1,
          borderColor: c.border,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text style={{ ...body, fontSize: 12 }}>{query.data?.version}</Text>
        <Button
          colors={c}
          icon="RefreshCw"
          disabled={query.isFetching || busy}
          onPress={() => {
            op.reset();
            void query.refetch();
            void jobs.refetch();
          }}
        >
          새로고침
        </Button>
      </View>
      <Modal
        title="확장 추가"
        open={dialog === "add"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content>
          <SettingsSelect
            label="종류"
            value={kind}
            options={Object.entries(kinds)
              .filter(
                ([k]) =>
                  harness !== "codex" || scope === "user" || k === "skill",
              )
              .map(([value, label]) => ({ value, label }))}
            onValueChange={(v) => {
              setKind(v as Kind);
              setValue(
                v === "mcp" ? '{\n  "command": "npx",\n  "args": []\n}' : "",
              );
            }}
          />
          <TextInput
            accessibilityLabel={
              kind === "plugin" ? "플러그인 이름@마켓플레이스" : "항목 이름"
            }
            placeholder={kind === "plugin" ? "이름@마켓플레이스" : "항목 이름"}
            placeholderTextColor={c.foregroundMuted}
            value={name}
            onChangeText={setName}
            autoCapitalize="none"
            style={{
              color: c.foreground,
              backgroundColor: c.surface2,
              borderRadius: 8,
              padding: 12,
              fontSize: 16,
            }}
          />
          {kind !== "plugin" && (
            <TextInput
              accessibilityLabel={
                kind === "skill"
                  ? "SKILL.md가 있는 호스트 폴더"
                  : kind === "marketplace"
                    ? "저장소 주소 또는 호스트 폴더"
                    : "MCP 설정 JSON"
              }
              placeholder={
                kind === "skill"
                  ? "SKILL.md가 있는 호스트 폴더"
                  : kind === "marketplace"
                    ? "owner/repository 또는 HTTPS 주소"
                    : "MCP 설정 JSON"
              }
              placeholderTextColor={c.foregroundMuted}
              value={value}
              onChangeText={setValue}
              autoCapitalize="none"
              multiline={kind === "mcp"}
              style={{
                color: c.foreground,
                backgroundColor: c.surface2,
                borderRadius: 8,
                padding: 12,
                fontSize: 16,
                minHeight: kind === "mcp" ? 180 : 44,
              }}
            />
          )}
          <Text style={body}>
            {kind === "plugin"
              ? "등록된 마켓플레이스의 플러그인을 네이티브 CLI로 설치합니다."
              : kind === "skill"
                ? "호스트의 스킬 폴더를 이 계정으로 복사합니다."
                : kind === "mcp"
                  ? "서버 구성과 인증 값은 이 계정에만 저장됩니다. 공통 구성에는 인증 값을 포함하지 않습니다."
                  : "설치 소스의 코드를 신뢰하는 경우에 추가하세요."}
          </Text>
          {op.error && (
            <Text
              accessibilityRole="alert"
              style={{ ...body, color: c.statusDanger }}
            >
              {message(op.error)}
            </Text>
          )}
          <Button
            colors={c}
            primary
            disabled={
              busy || !name.trim() || (kind !== "plugin" && !value.trim())
            }
            onPress={() =>
              op.mutate(async () => {
                await mutate({
                  target,
                  kind,
                  name: name.trim(),
                  action: "install",
                  value,
                  confirmed: true,
                });
                setDialog(null);
                setNotice("설치 작업을 등록했습니다.");
              })
            }
          >
            추가
          </Button>
        </Modal.Content>
      </Modal>
      <Modal
        title={item?.name ?? "항목 관리"}
        open={dialog === "detail"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content>
          {detailQuery.isFetching && (
            <ActivityIndicator
              accessibilityLabel="항목 조회 중"
              color={c.accent}
            />
          )}
          {item && (
            <Text style={body}>
              {kinds[item.kind]}
              {item.version ? ` · ${item.version}` : ""}
              {item.components.length ? ` · ${item.components.join(", ")}` : ""}
            </Text>
          )}
          {(detailQuery.error || op.error) && (
            <Text
              accessibilityRole="alert"
              style={{ ...body, color: c.statusDanger }}
            >
              {message((op.error ?? detailQuery.error)!)}
            </Text>
          )}
          {editing ? (
            <TextInput
              accessibilityLabel={
                item?.kind === "skill" ? "스킬 내용" : "MCP 설정 JSON"
              }
              value={value}
              onChangeText={setValue}
              multiline
              autoCapitalize="none"
              style={{
                color: c.foreground,
                backgroundColor: c.surface2,
                borderRadius: 8,
                padding: 12,
                fontSize: 16,
                minHeight: 240,
              }}
            />
          ) : (
            <Text
              selectable
              style={{
                ...body,
                fontFamily: item?.kind === "skill" ? undefined : "monospace",
              }}
            >
              {detailQuery.data?.text}
            </Text>
          )}
          {item?.authNeeded && (
            <Text style={body}>
              인증 값은 숨겨집니다. 빈 값은 이 계정에 이미 저장된 값을
              유지합니다.
            </Text>
          )}
          {item?.kind === "plugin" && (
            <Text style={body}>
              설치·업데이트는 마켓플레이스에서 제공하는 버전을 사용합니다.
            </Text>
          )}
          {item && !item.editable && (
            <Text style={body}>
              이 항목은 호스트나 다른 범위에서 관리합니다. 해당 위치에서
              변경하세요.
            </Text>
          )}
          {item?.editable && (
            <View style={{ gap: 12 }}>
              {remove ? (
                <>
                  <Text
                    style={{
                      color: c.foreground,
                      fontSize: 16,
                      lineHeight: 24,
                    }}
                  >
                    이 계정에서 {item.name}을 삭제할까요? 공통 구성과 다른
                    계정은 유지됩니다.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button
                      colors={c}
                      danger
                      disabled={busy}
                      onPress={() => act("remove")}
                    >
                      확인 후 삭제
                    </Button>
                    <Button colors={c} onPress={() => setRemove(false)}>
                      취소
                    </Button>
                  </View>
                </>
              ) : editing ? (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button
                    colors={c}
                    primary
                    disabled={busy || !value.trim()}
                    onPress={() =>
                      act(item.kind === "skill" ? "edit" : "configure")
                    }
                  >
                    저장
                  </Button>
                  <Button colors={c} onPress={() => setEditing(false)}>
                    취소
                  </Button>
                </View>
              ) : (
                <View
                  style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
                >
                  {item.kind === "plugin" && (
                    <Button
                      colors={c}
                      disabled={busy}
                      onPress={() => act(item.enabled ? "disable" : "enable")}
                    >
                      {item.enabled ? "비활성화" : "활성화"}
                    </Button>
                  )}
                  {["plugin", "marketplace"].includes(item.kind) && (
                    <Button
                      colors={c}
                      disabled={busy}
                      onPress={() => act("update")}
                    >
                      업데이트
                    </Button>
                  )}
                  {["skill", "mcp"].includes(item.kind) && (
                    <Button
                      colors={c}
                      disabled={busy || !detailQuery.data}
                      onPress={() => setEditing(true)}
                    >
                      편집
                    </Button>
                  )}
                  {item.kind === "mcp" && (
                    <Button
                      colors={c}
                      disabled={busy}
                      onPress={() => act("authenticate")}
                    >
                      기본 브라우저에서 인증
                    </Button>
                  )}
                  <Button
                    colors={c}
                    danger
                    disabled={busy}
                    onPress={() => setRemove(true)}
                  >
                    삭제
                  </Button>
                </View>
              )}
            </View>
          )}
        </Modal.Content>
      </Modal>
      <Modal
        title="공통 구성 적용"
        open={dialog === "apply"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content
          scrollable={false}
          contentContainerStyle={{ padding: 20, gap: 16 }}
        >
          <Text style={body}>
            {plan
              ? "계정 전용 항목과 기존 인증 값은 유지됩니다. 다른 구성을 교체할 항목만 선택하세요."
              : "공통 구성을 추가할 계정을 선택하세요."}
          </Text>
          <SheetScrollView
            style={{ maxHeight: layout.compact ? 360 : 460 }}
            contentContainerStyle={{ gap: 8 }}
          >
            {!plan
              ? rows.map((r) => (
                  <Check
                    key={r.id ?? "system"}
                    label={r.label}
                    colors={c}
                    checked={targets.includes(r.id ?? "system")}
                    onPress={() =>
                      setTargets(toggle(targets, r.id ?? "system"))
                    }
                  />
                ))
              : plan.steps.map((s, i) => {
                  const id = `${s.target.harness}:${s.target.accountId ?? "system"}:${s.key}`;
                  return (
                    <View
                      key={i}
                      style={{
                        paddingVertical: 10,
                        borderBottomWidth: 1,
                        borderColor: c.border,
                        gap: 4,
                      }}
                    >
                      <Text style={{ color: c.foreground, fontSize: 15 }}>
                        {label(s.target.accountId)} · {s.name}
                      </Text>
                      {s.action === "conflict" ? (
                        <Check
                          label="현재 구성을 공통 구성으로 교체"
                          checked={replacements.includes(id)}
                          onPress={() =>
                            setReplacements(toggle(replacements, id))
                          }
                          colors={c}
                        />
                      ) : (
                        <Text style={body}>{actions[s.action]}</Text>
                      )}
                    </View>
                  );
                })}
          </SheetScrollView>
          {plan?.steps.length === 0 && (
            <Text style={body}>적용할 공통 항목이 없습니다.</Text>
          )}
          {op.error && (
            <Text
              accessibilityRole="alert"
              style={{ ...body, color: c.statusDanger }}
            >
              {message(op.error)}
            </Text>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {plan ? (
              <>
                <Button
                  colors={c}
                  primary
                  disabled={busy || !plan.steps.length}
                  onPress={() =>
                    op.mutate(async () => {
                      await apply({
                        id: plan.id,
                        replace: replacements,
                        confirmed: true,
                      });
                      setDialog(null);
                      setNotice(
                        "공통 구성 적용을 등록했습니다. 실행 중인 작업이 끝나면 반영됩니다.",
                      );
                    })
                  }
                >
                  확인 후 적용
                </Button>
                <Button
                  colors={c}
                  disabled={busy}
                  onPress={() => setPlan(null)}
                >
                  계정 다시 선택
                </Button>
              </>
            ) : (
              <Button
                colors={c}
                primary
                disabled={busy || !targets.length}
                onPress={() =>
                  op.mutate(async () =>
                    setPlan(
                      await preview({
                        targets: targets.map((id) => ({
                          ...target,
                          accountId: id === "system" ? null : id,
                        })),
                        ...(selected.length ? { keys: selected } : {}),
                      }),
                    ),
                  )
                }
              >
                변경 내용 확인
              </Button>
            )}
          </View>
        </Modal.Content>
      </Modal>
      <Modal
        title="자동 적용 설정"
        open={dialog === "settings"}
        onOpenChange={(open) => {
          if (!open && !busy) setDialog(null);
        }}
      >
        <Modal.Content>
          <Text style={body}>
            두 서비스에 적용됩니다. 저장한 공통 구성에서 없는 항목만 추가합니다.
            다른 구성과 계정 전용 항목은 유지됩니다.
          </Text>
          <SettingsSwitch
            label="새 계정에 공통 구성 추가"
            value={query.data?.autoNew ?? false}
            disabled={busy}
            onValueChange={(autoNew) =>
              op.mutate(() => save({ target, keys: [], autoNew }))
            }
          />
          <SettingsSwitch
            label="계정 전환 시 빠진 공통 항목 추가"
            value={query.data?.autoSwitch ?? false}
            disabled={busy}
            onValueChange={(autoSwitch) =>
              op.mutate(() => save({ target, keys: [], autoSwitch }))
            }
          />
          {op.error && (
            <Text style={{ ...body, color: c.statusDanger }}>
              {message(op.error)}
            </Text>
          )}
        </Modal.Content>
      </Modal>
    </View>
  );
}
