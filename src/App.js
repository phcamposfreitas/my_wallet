import React, { Component } from 'react';
import logo from './logo.svg';
import './App.css';

import AssetPanel from './components/AssetPanel';

class App extends Component {
  render() {
    const ASSETS = [
      { name: 'LTN 2023', class:'Renda Fixa', year:'2023', owner:'Tesouro Direto', type:'Titulo Público'},
      { name: 'CDB Pan', class:'Renda Fixa', year:'2023', owner:'Banco Pan', type:'CDB'},
      { name: 'LCI BB', class:'Renda Fixa', year:'2023', owner:'Banco do Brasil', type:'LCI'},
      { name: 'CMIG4', class:'Renda Variável', year:'-', owner:'CEMIG', type:'Ações'},
      { name: 'BOVA11', class:'Renda Variável', year:'-', owner:'Bovespa', type:'ETF'}
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
