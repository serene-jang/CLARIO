param location string
param tags object
param identityName string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: identityName
  location: location
  tags: tags
}

resource githubFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-main'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:serene-jang@277176776/CLARIO@1423864194:ref:refs/heads/main'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output principalId string = identity.properties.principalId
output resourceId string = identity.id
