import { MouseEvent, useMemo, useRef, useState } from "react";
import { PricePoint, ProfitPoint } from "../types";

export interface PriceChartTradeMarker {
  id: string;
  date: Date;
  type: "BUY" | "SELL";
  shares: number;
  price: number;
}

interface PriceChartProps {
  points: PricePoint[];
  profitPoints?: ProfitPoint[];
  tradeMarkers?: PriceChartTradeMarker[];
  label?: string;
  valueLabel?: string;
  valueFormatter?: (value: number) => string;
  profitLabel?: string;
  profitFormatter?: (value: number) => string;
}

function formatTick(date: Date, spanDays: number): string {
  if (spanDays > 365 * 2) {
    return date.toLocaleDateString(undefined, { year: "numeric" });
  }
  if (spanDays > 120) {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
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

function formatPriceFallback(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : 4 });
}

function formatProfitFallback(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function PriceChart({
  points,
  profitPoints = [],
  tradeMarkers = [],
  label = "Valuation chart",
  valueLabel = "Price",
  valueFormatter = formatPriceFallback,
  profitLabel = "Profit",
  profitFormatter = formatProfitFallback,
}: PriceChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const width = 900;
  const height = 300;
  const padding = 24;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;

  const normalized = useMemo(
    () => [...points].filter((item) => Number.isFinite(item.price)).sort((a, b) => a.date.getTime() - b.date.getTime()),
    [points],
  );
  const normalizedProfit = useMemo(
    () =>
      [...profitPoints]
        .filter((item) => Number.isFinite(item.profit))
        .sort((a, b) => a.date.getTime() - b.date.getTime()),
    [profitPoints],
  );
  const normalizedTrades = useMemo(
    () => [...tradeMarkers].sort((a, b) => a.date.getTime() - b.date.getTime()),
    [tradeMarkers],
  );

  if (normalized.length === 0 && normalizedProfit.length === 0) {
    return (
      <div className="chart-empty compact">
        <span>No market price data</span>
      </div>
    );
  }

  const allTimelinePoints = [
    ...normalized.map((item) => item.date.getTime()),
    ...normalizedProfit.map((item) => item.date.getTime()),
    ...normalizedTrades.map((item) => item.date.getTime()),
  ];
  const minDate = Math.min(...allTimelinePoints);
  const maxDate = Math.max(...allTimelinePoints);
  const xRange = Math.max(1, maxDate - minDate);

  const priceValues = normalized.map((point) => point.price);
  const priceMin = priceValues.length > 0 ? Math.min(...priceValues) : 0;
  const priceMax = priceValues.length > 0 ? Math.max(...priceValues) : 1;
  const priceSpread = Math.max(1, priceMax - priceMin);
  const priceYMin = priceMin - priceSpread * 0.08;
  const priceYMax = priceMax + priceSpread * 0.08;
  const priceYRange = Math.max(1, priceYMax - priceYMin);

  const profitValues = normalizedProfit.map((point) => point.profit);
  const profitMin = profitValues.length > 0 ? Math.min(...profitValues) : -1;
  const profitMax = profitValues.length > 0 ? Math.max(...profitValues) : 1;
  const profitSpread = Math.max(1, profitMax - profitMin);
  const profitYMin = profitMin - profitSpread * 0.08;
  const profitYMax = profitMax + profitSpread * 0.08;
  const profitYRange = Math.max(1, profitYMax - profitYMin);

  const mapXByDate = (date: Date): number =>
    padding + ((date.getTime() - minDate) / xRange) * chartWidth;

  const mapPriceY = (price: number): number =>
    padding + ((priceYMax - price) / priceYRange) * chartHeight;

  const mapProfitY = (profit: number): number =>
    padding + ((profitYMax - profit) / profitYRange) * chartHeight;

  const projectedPrice = normalized.map((point) => {
    const x = mapXByDate(point.date);
    const y = mapPriceY(point.price);
    return { x, y, point };
  });

  const projectedProfit = normalizedProfit.map((point) => {
    const x = mapXByDate(point.date);
    const y = mapProfitY(point.profit);
    return { x, y, point };
  });

  const linePath = projectedPrice
    .map((projection, index) =>
      `${index === 0 ? "M" : "L"}${projection.x.toFixed(2)} ${projection.y.toFixed(2)}`,
    )
    .join(" ");
  const profitPath = projectedProfit
    .map((projection, index) =>
      `${index === 0 ? "M" : "L"}${projection.x.toFixed(2)} ${projection.y.toFixed(2)}`,
    )
    .join(" ");

  const areaPath = [
    `M${projectedPrice[0]?.x.toFixed(2) ?? padding} ${height - padding}`,
    ...projectedPrice.map((projection) => `L${projection.x.toFixed(2)} ${projection.y.toFixed(2)}`),
    `L${projectedPrice[projectedPrice.length - 1]?.x.toFixed(2) ?? width - padding} ${height - padding}`,
    "Z",
  ].join(" ");

  const spanDays = Math.max(1, Math.round((maxDate - minDate) / 86_400_000));
  const baseline = normalized[0]?.price ?? 0;

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }
    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 220);
    const maxY = Math.max(12, rect.height - 92);
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

    const nearestPrice =
      projectedPrice.length > 0
        ? projectedPrice.reduce((best, point) =>
            Math.abs(point.x - xTarget) < Math.abs(best.x - xTarget) ? point : best,
          )
        : null;
    const nearestProfit =
      projectedProfit.length > 0
        ? projectedProfit.reduce((best, point) =>
            Math.abs(point.x - xTarget) < Math.abs(best.x - xTarget) ? point : best,
          )
        : null;

    const markerHits = normalizedTrades.filter((marker) => Math.abs(mapXByDate(marker.date) - xTarget) <= 10);
    const focusTime =
      nearestPrice?.point.date ??
      nearestProfit?.point.date ??
      markerHits[0]?.date ??
      new Date(minDate + ((xTarget - padding) / chartWidth) * xRange);

    const lines = [focusTime.toLocaleDateString()];
    if (nearestPrice) {
      const changePct = baseline > 0 ? ((nearestPrice.point.price - baseline) / baseline) * 100 : 0;
      lines.push(`${valueLabel}: ${valueFormatter(nearestPrice.point.price)}`);
      lines.push(`Price Change: ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`);
    }
    if (nearestProfit) {
      lines.push(`${profitLabel}: ${profitFormatter(nearestProfit.point.profit)}`);
    }
    if (markerHits.length > 0) {
      markerHits.slice(0, 3).forEach((marker) => {
        lines.push(
          `${marker.type === "BUY" ? "BUY" : "SELL"} ${marker.shares.toFixed(2)} @ ${valueFormatter(marker.price)}`,
        );
      });
    }

    if (nearestPrice) {
      setHoveredIndex(projectedPrice.indexOf(nearestPrice));
    } else {
      setHoveredIndex(null);
    }
    showTooltip(event, lines);
  };

  const projectedTrades = normalizedTrades.map((marker) => {
    const x = mapXByDate(marker.date);
    const nearestPrice = projectedPrice.reduce<{ x: number; y: number } | null>((best, point) => {
      if (!best) {
        return point;
      }
      return Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best;
    }, null);
    const baseY = nearestPrice ? nearestPrice.y : padding + chartHeight / 2;
    const y = marker.type === "BUY" ? Math.max(padding + 10, baseY - 14) : Math.min(height - padding - 10, baseY + 14);
    return {
      ...marker,
      x,
      y,
    };
  });

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
        className="area-chart valuation-chart"
        viewBox={`0 0 ${width} ${height}`}
        aria-label={label}
        onMouseEnter={updateHoverFromXAxis}
        onMouseMove={updateHoverFromXAxis}
      >
        <defs>
          <linearGradient id="valuationAreaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(59, 130, 246, 0.32)" />
            <stop offset="100%" stopColor="rgba(59, 130, 246, 0.04)" />
          </linearGradient>
        </defs>

        {projectedPrice.length > 1 && <path d={areaPath} fill="url(#valuationAreaGradient)" />}
        {projectedPrice.length > 1 && (
          <path d={linePath} fill="none" stroke="#3b82f6" strokeWidth="2.8" strokeLinecap="round" />
        )}
        {projectedProfit.length > 1 && (
          <path d={profitPath} fill="none" stroke="#f59e0b" strokeWidth="2.4" strokeLinecap="round" />
        )}

        {projectedPrice.map((projection, index) => (
          <circle
            key={`price-point-${index}`}
            cx={projection.x}
            cy={projection.y}
            r={index === hoveredIndex ? 5 : 3}
            fill={index === hoveredIndex ? "#2563eb" : "#3b82f6"}
            className="chart-click-point"
            style={{ pointerEvents: "none" }}
          />
        ))}

        {projectedProfit.map((projection, index) => (
          <circle
            key={`profit-point-${index}`}
            cx={projection.x}
            cy={projection.y}
            r={2.6}
            fill="#f59e0b"
            style={{ pointerEvents: "none" }}
          />
        ))}

        {projectedTrades.map((marker) => (
          <g key={marker.id} transform={`translate(${marker.x}, ${marker.y})`}>
            <circle
              r={7}
              fill={marker.type === "BUY" ? "#16a34a" : "#dc2626"}
              stroke="#ffffff"
              strokeWidth="1.2"
              style={{ pointerEvents: "none" }}
            />
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fill="#ffffff"
              fontSize="8"
              fontWeight="800"
              style={{ pointerEvents: "none" }}
            >
              {marker.type === "BUY" ? "B" : "S"}
            </text>
          </g>
        ))}

        {buildTickIndexes(Math.max(2, normalized.length || normalizedProfit.length)).map((index, tickIndex, tickArray) => {
          const tickRate = tickArray.length > 1 ? index / (tickArray.length - 1) : 0;
          const tickDate = new Date(minDate + xRange * tickRate);
          const x = mapXByDate(tickDate);
          return (
            <g key={`tick-${tickIndex}`}>
              <line
                x1={x}
                y1={height - padding}
                x2={x}
                y2={height - padding + 8}
                stroke="#aeb7c4"
                strokeWidth="1"
              />
              <text
                x={x}
                y={height - padding + 20}
                textAnchor="middle"
                fill="#6b7280"
                fontSize="11"
              >
                {formatTick(tickDate, spanDays)}
              </text>
            </g>
          );
        })}

        <text x={padding} y={14} fill="#3b82f6" fontSize="11" fontWeight="700">
          {valueLabel}
        </text>
        <text x={width - padding} y={14} fill="#f59e0b" fontSize="11" fontWeight="700" textAnchor="end">
          {profitLabel}
        </text>
      </svg>
      <div className="combined-chart-legend">
        <span>
          <i className="chip chip-price" />
          {valueLabel}
        </span>
        <span>
          <i className="chip chip-profit" />
          {profitLabel}
        </span>
        <span>
          <i className="chip chip-buy">B</i>
          BUY
        </span>
        <span>
          <i className="chip chip-sell">S</i>
          SELL
        </span>
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
