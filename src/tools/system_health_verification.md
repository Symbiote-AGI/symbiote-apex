{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "System Health Verification Tool",
  "description": "Comprehensive tool for system state, hardware health, and service status verification",
  "type": "object",
  "properties": {
    "actions": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "system_state",
          "hardware_summary",
          "hardware_cpu",
          "hardware_memory",
          "hardware_disks",
          "hardware_gpu",
          "hardware_network",
          "hardware_usb",
          "hardware_audio",
          "hardware_camera",
          "hardware_bluetooth",
          "hardware_displays",
          "hardware_battery",
          "hardware_sensors",
          "hardware_processes",
          "runtime_status",
          "ports_listening",
          "gateway_status",
          "web_ui_status",
          "n8n_status",
          "ollama_status",
          "filesystem_status",
          "session_state",
          "comb_state",
          "memory_stats",
          "vdb_status",
          "processes_list",
          "system_logs",
          "config_status",
          "services_status",
          "health_checks",
          "resource_aggregator",
          "markets_status"
        ]
      }
    },
    "options": {
      "type": "object",
      "properties": {
        "include_detailed": {
          "type": "boolean",
          "description": "Include detailed output for verbose systems"
        },
        "format": {
          "type": "string",
          "enum": ["summary", "detailed", "json"],
          "description": "Output format"
        },
        "timeout": {
          "type": "number",
          "description": "Timeout in seconds for individual checks"
        }
      }
    }
  },
  "required": ["actions"]
}
