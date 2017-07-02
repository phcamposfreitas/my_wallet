import React, { Component } from 'react';
import logo from './logo.svg';
import './App.css';

import AssetPanel from './components/AssetPanel';

class App extends Component {
  render() {
    const ASSETS = [
      { name: 'LTN 2023', class:'Renda Fixa', year:'2023', owner:'Tesouro Direto', type:'Titulo Público', value:5.23 },
      { name: 'CDB Pan', class:'Renda Fixa', year:'2023', owner:'Banco Pan', type:'CDB', value:8.03},
      { name: 'LCI BB', class:'Renda Fixa', year:'2023', owner:'Banco do Brasil', type:'LCI', value:25.28},
      { name: 'CMIG4', class:'Renda Variável', year:'-', owner:'CEMIG', type:'Ações', value:45.0},
      { name: 'BOVA11', class:'Renda Variável', year:'-', owner:'Bovespa', type:'ETF', value:235.08}
    ];

    return (
      <div className="App">
        <div className="App-header">
          <img src={logo} className="App-logo" alt="logo" />
          <h2>Welcome to React</h2>
        </div>
        <AssetPanel assets={ASSETS}/>
        <footer>
          Footer App
        </footer>
      </div>
    );
  }
}

export default App;
