variable "scw_access_key" {
  description = "Scaleway access key (SCW_ACCESS_KEY)"
  type        = string
  sensitive   = true
}

variable "scw_secret_key" {
  description = "Scaleway secret key (SCW_SECRET_KEY)"
  type        = string
  sensitive   = true
}

variable "scw_organization_id" {
  description = "Scaleway organization ID"
  type        = string
}

variable "scw_project_id" {
  description = "Scaleway project ID"
  type        = string
}

variable "region" {
  description = "Scaleway region"
  type        = string
  default     = "nl-ams"
}

variable "zone" {
  description = "Scaleway availability zone"
  type        = string
  default     = "nl-ams-1"
}

variable "domain" {
  description = "Primary domain"
  type        = string
  default     = "contextlens.io"
}

variable "sessions_bucket_name" {
  description = "Object Storage bucket name for shared sessions (must be globally unique)"
  type        = string
  default     = "contextlens-io-sessions"
}

variable "container_image" {
  description = "Container registry image for the server (e.g. rg.nl-ams.scw.cloud/contextlens-io/server:latest)"
  type        = string
}
