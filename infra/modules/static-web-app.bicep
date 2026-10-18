param location string
param tags object
param staticWebAppName string

resource staticWebApp 'Microsoft.Web/staticSites@2025-05-01' = {
  name: staticWebAppName
  location: location
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

output resourceId string = staticWebApp.id
