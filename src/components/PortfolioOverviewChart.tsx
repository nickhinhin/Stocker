import { MouseEvent, useMemo, useRef, useState } from "react";
import { PortfolioOverviewPoint } from "../lib/calculations";

export interface PortfolioOverviewMetric {
  id: string;
  label: string;
  color: string;
  getValue: (point: PortfolioOverviewPoint) => number;
  formatValue: (value: number) => string;
}

interface PortfolioOverviewChartProps {
  points: PortfolioOverviewPoint[];
  metrics: PortfolioOverviewMetric[];
  noDataLabel: string;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function PortfolioOverviewChart({
  points,
  metrics,
  noDataLabel,
}: PortfolioOverviewChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  const width = 900;
  const height = 340;
  const padding = 26;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const visibleMetrics = useMemo(
    () => metrics.filter((metric) => typeof metric.getValue === "function"),
    [metrics],
  );

  if (points.length === 0 || visibleMetrics.length === 0) {
    return (
      <div className="chart-empty">
        <span>{noDataLabel}</span>
      </div>
    );
  }

  const minDate = points[0].date.getTime();
  const maxDate = points[points.length - 1].date.getTime();
  const xRange = Math.max(1, maxDate - minDate);

  const series = visibleMetrics.map((metric) => {
    const rawValues = points.map(metric.getValue);
    const minValue = Math.min(...rawValues);
    const maxValue = Math.max(...rawValues);
    const spread = Math.max(1, maxValue - minValue);
    const yMin = minValue - spread * 0.08;
    const yMax = maxValue + spread * 0.08;
    const yRange = Math.max(1, yMax - yMin);

    const chartPoints = points.map((point) => {
      const x = padding + ((point.date.getTime() - minDate) / xRange) * chartWidth;
      const value = metric.getValue(point);
      const y = padding + ((yMax - value) / yRange) * chartHeight;
      return { x, y, value };
    });

    const path = chartPoints
      .map((entry, index) => `${index === 0 ? "M" : "L"}${entry.x.toFixed(2)} ${entry.y.toFixed(2)}`)
      .join(" ");

    return {
      ...metric,
      chartPoints,
      path,
      latestValue: rawValues[rawValues.length - 1] ?? 0,
    };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }

    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 220);
    const maxY = Math.max(12, rect.height - 100);
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
    const index = Math.max(0, Math.min(points.length - 1, Math.round(rawIndex)));

    setHoveredIndex(index);
    const focusPoint = points[index];
    showTooltip(event, [
      focusPoint.date.toLocaleDateString(),
      ...series.map((metric) => `${metric.label}: ${metric.formatValue(metric.getValue(focusPoint))}`),
    ]);
  };

  return (
    <div
      ref={hostRef}
      className="line-chart-wrap chart-tooltip-host"
      onMouseLeave={() => {
        setHoveredIndex(null);
        setTooltip(null);
      }}
    >
      <svg
        className="line-chart"
        viewBox={`0 0 ${width} ${height}`}
        onMouseEnter={updateHoverFromXAxis}
        onMouseMove={updateHoverFromXAxis}
      >
        {ticks.map((tick) => {
          const y = padding + tick * chartHeight;
          return (
            <line
              key={`grid-${tick}`}
              x1={padding}
              x2={width - padding}
              y1={y}
              y2={y}
              stroke="#e9edf2"
              strokeWidth="1"
            />
          );
        })}

        {series.map((metric) => (
          <g key={metric.id}>
            <path
              d={metric.path}
              fill="none"
              stroke={metric.color}
              strokeWidth="2.2"
              strokeLinecap="round"
              className="line-path"
            />
            {metric.chartPoints.map((entry, index) => (
              <circle
                key={`${metric.id}-${index}`}
                cx={entry.x}
                cy={entry.y}
                r={hoveredIndex === index ? 4.5 : 2.8}
                fill={metric.color}
                className="chart-click-point"
                style={{ pointerEvents: "none" }}
              />
            ))}
          </g>
        ))}

        {ticks.map((tick) => {
          const x = padding + tick * chartWidth;
          const date = new Date(minDate + xRange * tick);
          return (
            <text
              key={`tick-${tick}`}
              x={x}
              y={height - 6}
              textAnchor="middle"
              fill="#6b7280"
              fontSize="11"
            >
              {formatDate(date)}
            </text>
          );
        })}
      </svg>

      <div className="line-legend">
        {series.map((metric) => (
          <div key={metric.id} className="line-legend-row">
            <span className="line-chip" style={{ background: metric.color }} />
            <span>{metric.label}</span>
            <strong>{metric.formatValue(metric.latestValue)}</strong>
          </div>
        ))}
      </div>
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
