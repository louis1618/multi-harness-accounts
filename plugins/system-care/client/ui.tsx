import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Pressable, Text } from "react-native";
export type Colors = PluginSurfaceProps["theme"]["colors"];
export function Button({
  children,
  onPress,
  colors,
  disabled = false,
  icon,
  primary = false,
  danger = false,
}: {
  children: ReactNode;
  onPress: () => void;
  colors: Colors;
  disabled?: boolean;
  icon?: string;
  primary?: boolean;
  danger?: boolean;
}) {
  const color = primary
    ? colors.accentForeground
    : danger
      ? colors.statusDanger
      : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        backgroundColor: primary
          ? colors.accent
          : pressed
            ? colors.surface2
            : colors.surface1,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.border,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {icon && <Icon name={icon} size={16} color={color} />}
      <Text style={{ color, fontSize: 14, fontWeight: "500" }}>{children}</Text>
    </Pressable>
  );
}
