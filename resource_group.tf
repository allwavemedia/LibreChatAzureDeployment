resource "azurerm_resource_group" "this" {
  name     = "rg-ava-${random_string.random_postfix.result}"
  location = var.location
}