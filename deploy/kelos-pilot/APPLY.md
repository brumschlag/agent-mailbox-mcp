# Deploy the agent-mailbox collaboration bridge (pilot)

Fork pinned at upstream `f54511da2911348dd587263beb25011dbbad7303`.
Context: `arn:aws:eks:us-east-1:565715328522:cluster/software-engineering`, ns `kelos-pilot`.
Always use `--context <ctx>` — never `kubectl config use-context` (shared kubeconfig).

Secrets are created imperatively below and are **never committed**.

## 0. Verify the kelos `headersFrom` shape (linchpin)
Confirm how `AgentConfig.spec.mcpServers[].headersFrom.secretRef` maps a Secret to request headers
in the installed CRD before trusting `kelos-collab.yaml`:
```bash
kubectl --context "$CTX" explain agentconfig.spec.mcpServers.headersFrom --recursive
```
If keys ≠ header names, adjust the `collab-bridge-headers` secret shape in step 3 accordingly.

## 1. Build + push the image (ECR, same-account → no cluster pull secret)
`TellihealthBedrockDeveloper` is DENIED `ecr:GetAuthorizationToken`/`DescribeRepositories` (confirmed).
Re-auth to an ECR-capable permission set (AdministratorAccess or equivalent) first — interactive, run
in your own terminal:
```bash
aws sso login --profile <admin-profile>
export AWS_PROFILE=<admin-profile>
```
Then build (amd64 native on WSL; cluster is amd64-majority) and push:
```bash
REPO=565715328522.dkr.ecr.us-east-1.amazonaws.com/agent-mailbox-mcp
aws ecr describe-repositories --region us-east-1 --repository-names agent-mailbox-mcp \
  || aws ecr create-repository --region us-east-1 --repository-name agent-mailbox-mcp \
       --image-tag-mutability IMMUTABLE
docker build --platform linux/amd64 -t "$REPO:0.1.0-amd64" ~/source/agent-mailbox-mcp
# WSL Docker-Desktop credential store chokes on ECR tokens ("stub received bad data") — isolate:
export DOCKER_CONFIG=$(mktemp -d)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "$REPO"
docker push "$REPO:0.1.0-amd64"
```
ECR tags are immutable — bump the tag to re-push. No `imagePullSecrets` (same-account node IAM pull).

## 2. Generate tokens + relay secret (high-entropy; never `change-me`)
```bash
ADMIN=$(openssl rand -hex 32)
LOCAL_TOKEN="amb_$(openssl rand -hex 24)"
KELOS_TOKEN="amb_$(openssl rand -hex 24)"
HTTP_TOKENS=$(jq -nc --arg l "$LOCAL_TOKEN" --arg k "$KELOS_TOKEN" '[
  {token:$l, agent_id:"local-brian", agent_name:"Local (Brian)", workspace:"inpulse"},
  {token:$k, agent_id:"kelos",       agent_name:"Kelos agent",   workspace:"inpulse"}
]')
kubectl --context "$CTX" -n kelos-pilot create secret generic mailbox-secrets \
  --from-literal=AGENT_MAILBOX_ADMIN_TOKEN="$ADMIN" \
  --from-literal=AGENT_MAILBOX_HTTP_TOKENS="$HTTP_TOKENS"
# Keep $LOCAL_TOKEN for step 5; $KELOS_TOKEN for step 3. Do not log them to the transcript.
```

## 3. kelos header secret (kelos agent's bearer)
```bash
kubectl --context "$CTX" -n kelos-pilot create secret generic collab-bridge-headers \
  --from-literal=Authorization="Bearer $KELOS_TOKEN"   # adjust per step 0
```

## 4. Apply relay + kelos resources
```bash
kubectl --context "$CTX" apply -f deploy/kelos-pilot/relay.yaml
kubectl --context "$CTX" -n kelos-pilot rollout status deploy/mailbox-mcp
kubectl --context "$CTX" apply -f deploy/kelos-pilot/kelos-collab.yaml
```

## 5. Wire the local agent + prove one round-trip
```bash
# local reach: port-forward the ClusterIP service
kubectl --context "$CTX" -n kelos-pilot port-forward svc/mailbox-mcp 8137:8080 &
claude mcp add agent-mailbox --transport http http://127.0.0.1:8137/mcp \
  --header "Authorization: Bearer $LOCAL_TOKEN"
```
Round-trip: local agent calls `session_start` then `send_message` to `kelos`; the `inpulse-collab`
Session calls `session_start`, sees the message, and replies; local agent sees the reply via `inbox`.

## Teardown
```bash
kubectl --context "$CTX" -n kelos-pilot delete -f deploy/kelos-pilot/kelos-collab.yaml -f deploy/kelos-pilot/relay.yaml
kubectl --context "$CTX" -n kelos-pilot delete secret mailbox-secrets collab-bridge-headers
kubectl --context "$CTX" -n kelos-pilot delete pvc mailbox-data
```
