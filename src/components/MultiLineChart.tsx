import { MouseEvent, useRef, useState } from "react";
import { CompareLineSeries } from "../lib/calculations";

interface MultiLineChartProps {
  series: CompareLineSeries[];
  title?: string;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function MultiLineChart({ series, title }: MultiLineChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ lineId: string; pointIndex: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const nonEmpty = series.filter((line) => line.points.length > 0);

  if (nonEmpty.length === 0) {
    return (
      <div className="chart-empty compact">
        <span>No data</span>
      </div>
    );
  }

  const allPoints = nonEmpty.flatMap((line) => line.points);
  const minDate = Math.min(...allPoints.map((point) => point.date.getTime()));
  const maxDate = Math.max(...allPoints.map((point) => point.date.getTime()));
  const minValue = Math.min(...allPoints.map((point) => point.profit));
  const maxValue = Math.max(...allPoints.map((point) => point.profit));

  const width = 920;
  const height = 320;
  const padding = 26;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const xRange = Math.max(1, maxDate - minDate);
  const yPadding = Math.max(1, (maxValue - minValue) * 0.08);
  const yMin = minValue - yPadding;
  const yMax = maxValue + yPadding;
  const yRange = Math.max(1, yMax - yMin);

  const paths = nonEmpty.map((line) => {
    const chartPoints = line.points.map((point, index) => {
      const x = padding + ((point.date.getTime() - minDate) / xRange) * chartWidth;
      const y = padding + ((yMax - point.profit) / yRange) * chartHeight;
      return {
        point,
        index,
        x,
        y,
      };
    });
    const d = chartPoints
      .map((entry) => `${entry.index === 0 ? "M" : "L"}${entry.x.toFixed(2)} ${entry.y.toFixed(2)}`)
      .join(" ");
    return { ...line, d, chartPoints };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1];

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
    const xTarget = Math.max(padding, Math.min(width - padding, xInViewBox));

    const nearestByLine = paths.map((line) => {
      const nearestPoint = line.chartPoints.reduce((best, point) => {
        return Math.abs(point.x - xTarget) < Math.abs(best.x - xTarget) ? point : best;
      }, line.chartPoints[0]);
      return { line, point: nearestPoint };
    });

    const focal = nearestByLine.reduce((best, current) => {
      return Math.abs(current.point.x - xTarget) < Math.abs(best.point.x - xTarget) ? current : best;
    }, nearestByLine[0]);

    setHovered({ lineId: focal.line.id, pointIndex: focal.point.index });
    showTooltip(event, [
      focal.point.point.date.toLocaleDateString(),
      ...nearestByLine.map(({ line, point }) =>
        `${line.label}: ${point.point.profit >= 0 ? "+" : ""}${point.point.profit.toLocaleString(undefined, {
          maximumFractionDigits: 2,
        })}`,
      ),
    ]);
  };

  return (
    <div
      ref={hostRef}
      className="mini-chart-card chart-tooltip-host"
      onMouseLeave={() => {
        setHovered(null);
        setTooltip(null);
      }}
    >
      {title && <h4>{title}</h4>}
      <div className="line-chart-wrap">
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

          {paths.map((line) => (
            <g key={line.id}>
              <path
                d={line.d}
                fill="none"
                stroke={line.color}
                strokeWidth="2.2"
                strokeLinecap="round"
                className="line-path"
              />
              {line.chartPoints.map((entry) => (
                <circle
                  key={`${line.id}-${entry.index}`}
                  cx={entry.x}
                  cy={entry.y}
                  r={hovered?.lineId === line.id && hovered.pointIndex === entry.index ? 4.6 : 3}
                  fill={line.color}
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
          {nonEmpty.map((line) => (
            <div key={line.id} className="line-legend-row">
              <span className="line-chip" style={{ background: line.color }} />
              <span>{line.label}</span>
              <strong>{line.points[line.points.length - 1].profit.toFixed(1)}</strong>
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
    </div>
  );
}
