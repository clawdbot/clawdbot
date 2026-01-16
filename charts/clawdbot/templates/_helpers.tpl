{{- define "clawdbot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "clawdbot.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "clawdbot.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "clawdbot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "clawdbot.selectorLabels" -}}
app.kubernetes.io/name: {{ include "clawdbot.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "clawdbot.labels" -}}
helm.sh/chart: {{ include "clawdbot.chart" . }}
{{ include "clawdbot.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "clawdbot.pvcName" -}}
{{- $root := index . 0 -}}
{{- $suffix := index . 1 -}}
{{- $base := include "clawdbot.fullname" $root -}}
{{- $maxBaseLen := int (sub 63 (len $suffix)) -}}
{{- $trimLen := ternary 1 $maxBaseLen (lt $maxBaseLen 1) -}}
{{- $trimmed := trunc (int $trimLen) $base | trimSuffix "-" -}}
{{- printf "%s%s" $trimmed $suffix -}}
{{- end -}}

{{- define "clawdbot.browserServiceName" -}}
{{- printf "%s-browser" (include "clawdbot.fullname" .) -}}
{{- end -}}

{{- define "clawdbot.configJson" -}}
{{- if not (kindIs "map" .Values.config) -}}
{{- fail "Values.config must be a map/object (YAML). Update your values file to use the structured config." -}}
{{- end -}}
{{- $cfg := deepCopy .Values.config -}}
{{- if .Values.browserDeployment.enabled -}}
  {{- $browser := get $cfg "browser" -}}
  {{- if and $browser (not (kindIs "map" $browser)) -}}
    {{- fail "Values.config.browser must be a map/object (YAML) when browserDeployment.enabled is true." -}}
  {{- end -}}
  {{- if not $browser -}}
    {{- $browser = dict -}}
  {{- end -}}
  {{- $browserPort := default .Values.browserDeployment.port .Values.browserDeployment.service.port -}}
  {{- if not (hasKey $browser "cdpUrl") -}}
    {{- $_ := set $browser "cdpUrl" (printf "http://%s:%v" (include "clawdbot.browserServiceName" .) $browserPort) -}}
  {{- end -}}
  {{- if not (hasKey $browser "attachOnly") -}}
    {{- $_ := set $browser "attachOnly" true -}}
  {{- end -}}
  {{- if not (hasKey $cfg "browser") -}}
    {{- $_ := set $cfg "browser" $browser -}}
  {{- end -}}
{{- end -}}
{{- toJson $cfg -}}
{{- end -}}

{{- define "clawdbot.gatewayAuthToken" -}}
{{- if not (kindIs "map" .Values.config) -}}
{{- fail "Values.config must be a map/object (YAML). Update your values file to use the structured config." -}}
{{- end -}}
{{- $token := dig "gateway" "auth" "token" "" .Values.config -}}
{{- if and (kindIs "string" $token) (ne (trim $token) "") -}}
{{- trim $token -}}
{{- end -}}
{{- end -}}
