import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-slate-900 text-white",
        secondary: "border-slate-200 bg-slate-100 text-slate-600",
        outline: "border-slate-200 bg-white/60 text-slate-600",
        success: "border-emerald-200 bg-emerald-100/70 text-emerald-700",
        blue: "border-blue-200 bg-blue-100/70 text-blue-700",
        orange: "border-orange-200 bg-orange-100/70 text-orange-700",
        destructive: "border-red-200 bg-red-100/70 text-red-700",
        // 状态变体：消费 index.css 的 M13 设计令牌，与地图 overlay 颜色一一对应
        candidate: "border-candidate/40 bg-candidate/15 text-slate-500",
        locked: "border-locked/30 bg-locked/10 text-locked",
        scheduled: "border-scheduled/30 bg-scheduled/10 text-scheduled",
      },
    },
    defaultVariants: { variant: "secondary" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
