import { MouseEvent, useRef, useState } from "react";
import { ProfitPoint } from "../types";

interface AreaChartProps {
  points: ProfitPoint[];
  label?: string;
}

function formatTick(date: Date, spanDays: number): string {
  if (spanDays > 365 * 2) {
    return date.toLocaleDateString(undefined, { year: "numeric" });
  }
  if (spanDays > 120) {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  if (spanDays > 45) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildTickIndexes(pointCount: number): number[] {
  if (pointCount <= 1) {
    return [0];
  }

  const tickCount = Math.min(6, pointCount);
  const indexes: number[] = [];
  for (let i = 0; i < tickCount; i += 1) {
    const index = Math.round((i * (pointCount - 1)) / (tickCount - 1));
    if (!indexes.includes(index)) {
      indexes.push(index);
    }
  }

  return indexes;
}

export default function AreaChart({ points, label = "Profit chart" }: AreaChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const width = 900;
  const height = 360;
  const padding = 24;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  if (points.length === 0) {
    return (
      <div className="chart-empty">
        <span>No data</span>
      </div>
    );
  }

  const values = points.map((point) => point.profit);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(1, max - min);
  const yMin = min - spread * 0.08;
  const yMax = max + spread * 0.08;

  const projected = points.map((point, index) => {
    const x = padding + (index / Math.max(points.length - 1, 1)) * chartWidth;
    const y =
      padding + ((yMax - point.profit) / Math.max(yMax - yMin, 1)) * chartHeight;
    return { x, y, point };
  });

  const linePath = projected
    .map((projection, index) =>
      `${index === 0 ? "M" : "L"}${projection.x.toFixed(2)} ${projection.y.toFixed(2)}`,
    )
    .join(" ");

  const areaPath = [
    `M${projected[0].x.toFixed(2)} ${height - padding}`,
    ...projected.map((projection) => `L${projection.x.toFixed(2)} ${projection.y.toFixed(2)}`),
    `L${projected[projected.length - 1].x.toFixed(2)} ${height - padding}`,
    "Z",
  ].join(" ");

  const spanDays = Math.max(
    1,
    Math.round(
      (points[points.length - 1].date.getTime() - points[0].date.getTime()) / 86_400_000,
    ),
  );
  const tickIndexes = buildTickIndexes(points.length);

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }
    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 190);
    const maxY = Math.max(12, rect.height - 88);
    setTooltip({
      x: Math.min(maxX, Math.max(12, rawX)),
      y: Math.min(maxY, Math.max(12, rawY)),
      lines,
    });
  };

  const updateHoverFromXAxis = (event: MouseEvent<SVGSVGElement>): void => {
    const svgRect = event.currentTarget.getBoundingClientRect();
    const normalizedX = (event.clientX - svgRect.left) / Math.max(svgRect.width, 1);
    const xInViewBox = normalizedX * width;
    const rawIndex = ((xInViewBox - padding) / Math.max(chartWidth, 1)) * Math.max(points.length - 1, 1);
    const clampedIndex = Math.max(0, Math.min(points.length - 1, Math.round(rawIndex)));
    const projection = projected[clampedIndex];
    setHoveredIndex(clampedIndex);
    showTooltip(event, [
      projection.point.date.toLocaleDateString(),
      `Profit: ${projection.point.profit >= 0 ? "+" : ""}${projection.point.profit.toLocaleString(undefined, {
        maximumFractionDigits: 2,
      })}`,
    ]);
  };

  return (
    <div
      ref={hostRef}
      className="area-chart-wrap chart-tooltip-host"
      onMouseLeave={() => {
        setHoveredIndex(null);
        setTooltip(null);
      }}
    >
      <svg
        className="area-chart"
        viewBox={`0 0 ${width} ${height}`}
        aria-label={label}
        onMouseEnter={updateHoverFromXAxis}
        onMouseMove={updateHoverFromXAxis}
      >
        <defs>
          <linearGradient id="profitAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(47, 156, 130, 0.34)" />
            <stop offset="100%" stopColor="rgba(47, 156, 130, 0.02)" />
          </linearGradient>
        </defs>

        <path d={areaPath} fill="url(#profitAreaGradient)" />
        <path d={linePath} fill="none" stroke="#2f9c82" strokeWidth="2.8" strokeLinecap="round" />

        {projected.map((projection, index) => (
          <circle
            key={`point-${index}`}
            cx={projection.x}
            cy={projection.y}
            r={index === hoveredIndex ? 5 : 3}
            fill={index === hoveredIndex ? "#1f7f65" : "#2f9c82"}
            className="chart-click-point"
            style={{ pointerEvents: "none" }}
          />
        ))}

        {tickIndexes.map((index) => {
          const projection = projected[index];
          return (
            <g key={`tick-${index}`}>
              <line
                x1={projection.x}
                y1={height - padding}
                x2={projection.x}
                y2={height - padding + 8}
                stroke="#aeb7c4"
                strokeWidth="1"
              />
              <text
                x={projection.x}
                y={height - padding + 20}
                textAnchor="middle"
                fill="#6b7280"
                fontSize="11"
              >
                {formatTick(projection.point.date, spanDays)}
              </text>
            </g>
          );
        })}
      </svg>
      {tooltip && (
        <div className="chart-hover-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.lines.map((line, index) => (
            <div key={`${line}-${index}`} className="chart-hover-tooltip-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
