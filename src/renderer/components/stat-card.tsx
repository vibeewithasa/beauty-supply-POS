import { ReactNode } from "react";
import { Card } from "./ui/card";

interface StatCardProps {
  label: string;
  value: string | number;
  icon?: ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
  variant?: "default" | "success" | "warning" | "danger";
}

export function StatCard({
  label,
  value,
  icon,
  trend,
  variant = "default",
}: StatCardProps) {
  const colorClasses = {
    default: "border-l-4 border-l-primary",
    success: "border-l-4 border-l-green-600",
    warning: "border-l-4 border-l-yellow-600",
    danger: "border-l-4 border-l-red-600",
  };

  return (
    <Card className={`card-pos-stat ${colorClasses[variant]}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="card-pos-stat-label">{label}</p>
          <p className="card-pos-stat-value mt-2">{value}</p>
          {trend && (
            <p
              className={`text-xs font-medium mt-2 ${
                trend.isPositive ? "text-green-600" : "text-red-600"
              }`}
            >
              {trend.isPositive ? "+" : ""}{trend.value}%
            </p>
          )}
        </div>
        {icon && <div className="text-3xl opacity-20">{icon}</div>}
      </div>
    </Card>
  );
}
