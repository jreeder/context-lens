output "container_domain" {
  description = "Direct Serverless Container domain (before custom domain)"
  value       = scaleway_container.server.domain_name
}

output "edge_services_default_fqdn" {
  description = "Default Edge Services FQDN (before DNS is wired)"
  value       = scaleway_edge_services_dns_stage.main.default_fqdn
}

output "sessions_bucket_endpoint" {
  description = "Sessions Object Storage bucket endpoint"
  value       = scaleway_object_bucket.sessions.endpoint
}

output "pipeline_id" {
  description = "Edge Services pipeline ID"
  value       = scaleway_edge_services_pipeline.main.id
}
