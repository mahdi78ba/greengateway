{{/* Standard naming and label helpers. Release "ggw" + chart "greengateway" -> "ggw-greengateway". */}}
{{- define "greengateway.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "greengateway.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "greengateway.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "greengateway.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
app.kubernetes.io/name: {{ include "greengateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "greengateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "greengateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Where the gateway sends chat completions. */}}
{{- define "greengateway.upstreamBase" -}}
{{- if .Values.mock.enabled -}}
http://{{ include "greengateway.fullname" . }}-mock:8099
{{- else -}}
{{ .Values.openrouter.base }}
{{- end -}}
{{- end -}}

{{- define "greengateway.redisUrl" -}}
{{- if .Values.redis.url -}}
{{ .Values.redis.url }}
{{- else -}}
redis://{{ include "greengateway.fullname" . }}-redis:6379
{{- end -}}
{{- end -}}

{{/* The same hardening for every container: non-root, read-only filesystem, no capabilities. */}}
{{- define "greengateway.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}
