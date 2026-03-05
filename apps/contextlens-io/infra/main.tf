terraform {
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.69"
    }
  }
  required_version = "~> 1.14"

  # Remote state in Scaleway Object Storage.
  # Bootstrap: scw --profile xithing object bucket create name=contextlens-io-tfstate region=nl-ams
  # Then: export AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (from .envrc) and run: terraform init
  backend "s3" {
    bucket   = "contextlens-io-tfstate"
    key      = "contextlens-io.tfstate"
    region   = "us-east-1"
    endpoints = {
      s3 = "https://s3.nl-ams.scw.cloud"
    }
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    use_path_style              = true
  }
}

provider "scaleway" {
  access_key      = var.scw_access_key
  secret_key      = var.scw_secret_key
  organization_id = var.scw_organization_id
  project_id      = var.scw_project_id
  region          = var.region
  zone            = var.zone
}

# ---------------------------------------------------------------------------
# Object Storage: session files (7-day TTL via lifecycle rule)
# ---------------------------------------------------------------------------

resource "scaleway_object_bucket" "sessions" {
  name   = var.sessions_bucket_name
  region = var.region

  # Automatically delete objects older than 8 days (server TTL is 7 days,
  # this is a safety net for objects the server missed).
  lifecycle_rule {
    id      = "expire-sessions"
    enabled = true
    expiration {
      days = 8
    }
  }

  tags = {
    project = "contextlens-io"
  }
}

# Bucket policy: private (server accesses via API key, not public)

# ---------------------------------------------------------------------------
# Serverless Container: the Hono server
# ---------------------------------------------------------------------------

resource "scaleway_container_namespace" "main" {
  name        = "contextlens-io"
  description = "contextlens.io upload and share service"
  region      = var.region
  project_id  = var.scw_project_id
}

resource "scaleway_container" "server" {
  name           = "contextlens-io-server"
  namespace_id   = scaleway_container_namespace.main.id
  registry_image = var.container_image
  port           = 3000
  cpu_limit      = 560  # milli-CPU
  memory_limit   = 256  # MB
  min_scale      = 0
  max_scale      = 3
  timeout        = 60   # seconds per request
  privacy        = "public"
  deploy         = true

  environment_variables = {
    BASE_URL          = "https://${var.domain}"
    RATE_LIMIT_UPLOADS = "10"
    # Session storage via S3-compatible Object Storage
    STORAGE_BACKEND   = "s3"
    S3_BUCKET         = scaleway_object_bucket.sessions.name
    S3_REGION         = var.region
    S3_ENDPOINT       = "https://s3.${var.region}.scw.cloud"
  }

  secret_environment_variables = {
    S3_ACCESS_KEY = var.scw_access_key
    S3_SECRET_KEY = var.scw_secret_key
  }
}

# ---------------------------------------------------------------------------
# Edge Services: TLS + custom domain in front of the container
# ---------------------------------------------------------------------------

resource "scaleway_edge_services_plan" "main" {
  name = "starter"
}

resource "scaleway_edge_services_pipeline" "main" {
  name        = "contextlens-io-pipeline"
  description = "contextlens.io"
  depends_on  = [scaleway_edge_services_plan.main]
}

resource "scaleway_edge_services_backend_stage" "main" {
  pipeline_id = scaleway_edge_services_pipeline.main.id
  # Forward all traffic to the Serverless Container.
  # Scaleway Edge Services supports custom backend URLs from v2.70+.
  custom_backend_config {
    servers {
      host  = regex("https?://([^/]+)", scaleway_container.server.domain_name)[0]
      port  = 443
    }
    is_ssl = true
  }
}

resource "scaleway_edge_services_cache_stage" "main" {
  pipeline_id      = scaleway_edge_services_pipeline.main.id
  backend_stage_id = scaleway_edge_services_backend_stage.main.id
  # Only cache static assets; API and share pages should not be cached at edge.
  fallback_ttl = 0
}

resource "scaleway_edge_services_tls_stage" "main" {
  pipeline_id         = scaleway_edge_services_pipeline.main.id
  cache_stage_id      = scaleway_edge_services_cache_stage.main.id
  managed_certificate = true
}

resource "scaleway_edge_services_dns_stage" "main" {
  pipeline_id  = scaleway_edge_services_pipeline.main.id
  tls_stage_id = scaleway_edge_services_tls_stage.main.id
  fqdns        = ["www.${var.domain}"]
}

resource "scaleway_edge_services_head_stage" "main" {
  pipeline_id   = scaleway_edge_services_pipeline.main.id
  head_stage_id = scaleway_edge_services_dns_stage.main.id
}

# ---------------------------------------------------------------------------
# DNS (managed by Scaleway DNS, domain registered elsewhere)
# ---------------------------------------------------------------------------

resource "scaleway_domain_zone" "main" {
  domain    = var.domain
  subdomain = ""
}

# www -> Edge Services
resource "scaleway_domain_record" "www" {
  dns_zone = var.domain
  name     = "www"
  type     = "CNAME"
  data     = "${scaleway_edge_services_dns_stage.main.default_fqdn}."
  ttl      = 300
}

# Apex redirect function (same pattern as transitiedata.nl)
resource "scaleway_function_namespace" "redirect" {
  name        = "contextlens-io-redirect"
  description = "Apex redirect for contextlens.io"
  region      = var.region
  project_id  = var.scw_project_id
}

resource "scaleway_function" "redirect" {
  name         = "apex-redirect"
  namespace_id = scaleway_function_namespace.redirect.id
  runtime      = "node22"
  handler      = "handler.handle"
  privacy      = "public"
  zip_file     = "${path.module}/redirect-fn/redirect.zip"
  zip_hash     = filemd5("${path.module}/redirect-fn/redirect.zip")
  deploy       = true
  min_scale    = 0
  max_scale    = 2
  memory_limit = 128
}

resource "scaleway_function_domain" "apex" {
  function_id = scaleway_function.redirect.id
  hostname    = var.domain
}

resource "scaleway_domain_record" "apex" {
  dns_zone = var.domain
  name     = ""
  type     = "ALIAS"
  data     = "${scaleway_function.redirect.domain_name}."
  ttl      = 300
}
