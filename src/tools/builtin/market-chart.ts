import { MARKET_CHART_INTERVALS, MARKET_CHART_SYMBOLS, MARKET_INDICATOR_KINDS, type MarketChartWorkspaceStore } from '../../markets/chart-workspace.js';
import type { ToolDefinition } from '../types.js';

export function createMarketChartTool(store: MarketChartWorkspaceStore): ToolDefinition {
  return {
    name: 'market_chart_manage',
    description: 'Read or update the persistent chart workspace shown to the user in Markets. Supports SMA, EMA, RSI, ATR, and Bollinger indicators plus horizontal and trendline drawings. These changes are saved and appear in the user interface.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add_indicator', 'remove_indicator', 'add_drawing', 'remove_drawing'], description: 'Chart workspace operation.' },
        symbol: { type: 'string', enum: [...MARKET_CHART_SYMBOLS], description: 'Market symbol.' },
        interval: { type: 'string', enum: [...MARKET_CHART_INTERVALS], description: 'Chart interval.' },
        id: { type: 'string', description: 'Indicator or drawing ID to remove.' },
        indicator: {
          type: 'object',
          description: 'Indicator to add.',
          properties: {
            kind: { type: 'string', enum: [...MARKET_INDICATOR_KINDS], description: 'Indicator calculation.' },
            period: { type: 'number', description: 'Lookback period from 2 to 500; defaults to 20.' },
            color: { type: 'string', description: 'Optional six-digit hex color.' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
        drawing: {
          type: 'object',
          description: 'Drawing to add. Timestamps are Unix seconds and prices must be positive.',
          properties: {
            kind: { type: 'string', enum: ['horizontal', 'trendline'], description: 'Drawing shape.' },
            points: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  time: { type: 'number', description: 'Unix timestamp in seconds.' },
                  price: { type: 'number', description: 'Price at this point.' },
                },
                required: ['time', 'price'],
                additionalProperties: false,
              },
            },
            label: { type: 'string', description: 'Optional short drawing label.' },
            color: { type: 'string', description: 'Optional six-digit hex color.' },
          },
          required: ['kind', 'points'],
          additionalProperties: false,
        },
      },
      required: ['action', 'symbol', 'interval'],
    },
    idempotency: { class: 'reversible_local', reverseDescription: 'Remove an added indicator or drawing, or restore the previously saved chart state.' },
    execute: async input => {
      if (typeof input.symbol !== 'string' || typeof input.interval !== 'string') {
        throw new Error('A supported market symbol and interval are required.');
      }
      switch (input.action) {
        case 'read':
          return JSON.stringify(store.get(input.symbol, input.interval), null, 2);
        case 'add_indicator':
          return JSON.stringify(store.addIndicator(input.symbol, input.interval, input.indicator), null, 2);
        case 'remove_indicator':
          return JSON.stringify(store.removeIndicator(input.symbol, input.interval, input.id), null, 2);
        case 'add_drawing':
          return JSON.stringify(store.addDrawing(input.symbol, input.interval, input.drawing), null, 2);
        case 'remove_drawing':
          return JSON.stringify(store.removeDrawing(input.symbol, input.interval, input.id), null, 2);
        default:
          throw new Error('Choose a supported market chart operation.');
      }
    },
  };
}
