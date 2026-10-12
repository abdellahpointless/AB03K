import firebaseRulesPlugin from '@firebase/eslint-plugin-security-rules';

export default [
  {
    ignores: ['dist/**/*', 'node_modules/**/*']
  },
  {
    plugins: {
      'firebase-rules': firebaseRulesPlugin
    },
    // The plugin requires specific processor setup depending on version, let's use configs
    ...firebaseRulesPlugin.configs['flat/recommended']
  }
];
